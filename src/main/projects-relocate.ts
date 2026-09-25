import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { promises as fsp } from 'node:fs'
import * as path from 'node:path'
import { mergeDir, type AddToProjectConflict, type AddToProjectResult } from './projects-add-to'
import {
  buildDestination,
  findPluginsForModules,
  findScriptModules,
  listContentPlugins,
  listLoosePackages,
  listProjectPluginNames,
  listTopLevelFolders,
  renderRelocateScript,
  renderUpluginStub,
  renderUproject,
  type AddToProjectDestination
} from './projects-relocate-plan'
import { mountRoot } from '../shared/relocate-destination'

/**
 * "Add to project" into a `/Game` subfolder or a content plugin, with every
 * internal reference fixed up.
 *
 * Package paths live inside each `.uasset` / `.umap`, so a plain copy to a new
 * folder leaves references dangling. Instead we build a throwaway scratch
 * project next to ReHoarder's user data, copy the pack in at its original
 * `/Game/...` location, let the project's own engine move it headlessly
 * (`UnrealEditor-Cmd.exe -run=pythonscript`), and only then merge the moved
 * result into the real project. The real project is never opened by Unreal
 * and is not touched until the relocated files are ready.
 */

export type RelocateStage = 'prepare' | 'copy-in' | 'editor' | 'copy-out' | 'cleanup'

export interface RelocateRequest {
  /** Caller-chosen id: names the scratch folder and keys cancellation. */
  jobId: string
  /** The pack's source `Content/` directory. */
  sourceContentDir: string
  /** Target project root (folder holding the `.uproject`). */
  projectDir: string
  uprojectPath: string
  conflict: AddToProjectConflict
  destination: AddToProjectDestination
}

export type SpawnFn = (cmd: string, args: string[], opts: SpawnOptions) => ChildProcess

export interface RelocateDeps {
  /** Parent of the per-job scratch projects, normally `<userData>/relocate`. */
  scratchRoot: string
  /** Resolve the commandlet runner for the target project's engine. */
  resolveEditor: (
    uprojectPath: string
  ) => Promise<{ cmdExe: string; engineName: string; engineRoot?: string } | { error: string }>
  spawn?: SpawnFn
  killTree?: (proc: ChildProcess) => void
}

const JOB_ID_RE = /^[A-Za-z0-9_-]{1,64}$/
const TAIL_LINES = 200
/** Files Unreal moves as part of a package; anything else is carried over by path. */
const PACKAGE_EXTS = ['.uasset', '.umap', '.uexp', '.ubulk', '.uptnl']
const EXTERNAL_FOLDERS = ['__ExternalActors__', '__ExternalObjects__']

/**
 * Kill a process and all its children. On Windows `UnrealEditor-Cmd.exe` can
 * spawn helpers (shader workers, crash reporter), and `proc.kill()` only
 * terminates the direct child, so we go through `taskkill /T /F`.
 */
export function killProcessTree(
  proc: ChildProcess,
  platform: NodeJS.Platform = process.platform,
  spawnFn: SpawnFn = nodeSpawn
): void {
  if (platform === 'win32' && proc.pid !== undefined) {
    try {
      const killer = spawnFn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], {
        windowsHide: true
      })
      killer?.on?.('error', () => proc.kill())
    } catch {
      proc.kill()
    }
    return
  }
  proc.kill('SIGKILL')
}

interface ScriptResult {
  ok: boolean
  moved: number
  redirectorsLeft: number
  redirectors: string[]
  errors: string[]
  /** The whole rename batch was refused and nothing changed. */
  refusedBatch: boolean
}

async function readScriptResult(resultPath: string): Promise<ScriptResult | null> {
  try {
    const j = JSON.parse(await fsp.readFile(resultPath, 'utf-8')) as Record<string, unknown>
    const strings = (v: unknown): string[] =>
      Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
    return {
      ok: j.ok === true,
      moved: typeof j.moved === 'number' ? j.moved : 0,
      redirectorsLeft: typeof j.redirectorsLeft === 'number' ? j.redirectorsLeft : 0,
      redirectors: strings(j.redirectors),
      errors: strings(j.errors),
      refusedBatch: j.refusedBatch === true
    }
  } catch {
    return null
  }
}

interface EditorRun {
  exitCode: number | null
  output: string
  cancelled: boolean
  error?: string
  /** Asset names Unreal's CDO-reference rename prompt listed (answered Cancel when unattended). */
  refusedNames?: string[]
}

/**
 * Errors from the commandlet's "Warning/Error Summary (Unique only)" block,
 * as `<asset>: <message>`. These make Unreal exit with code 1 even when the
 * move succeeded, and they usually come from the pack itself (broken level
 * Blueprints, removed engine features), so the user gets them by name.
 */
export function summarizeEditorErrors(output: string): string[] {
  const start = output.indexOf('Warning/Error Summary')
  if (start < 0) return []
  const out: string[] = []
  for (const line of output.slice(start).split(/\r?\n/)) {
    const m = line.match(/Display: \w+: Error: (.*)$/)
    if (!m) continue
    let text = m[1]
    let asset = ''
    const tagged = text.match(/^\[AssetLog\] (.+?\.(?:uasset|umap)): (?:\[\w+\] )?(.*)$/)
    if (tagged) {
      asset = path.basename(tagged[1].replace(/\\/g, '/'), path.extname(tagged[1]))
      text = tagged[2]
    }
    text = text.replace(/\s+from Source: .*$/, '').trim()
    const entry = asset ? `${asset}: ${text}` : text
    if (!out.includes(entry)) out.push(entry)
  }
  return out
}

const RENAME_PROMPT_RE =
  /may need Find\/Replace for:\s*\n([\s\S]*?)\n\s*\n\s*Otherwise assets can be missing/g

/**
 * Asset names listed by the rename manager's "Source code, config INI, and
 * text files may need Find/Replace for: ... Continue with rename?" prompt,
 * which unattended mode answers Cancel, refusing the whole batch.
 */
export function parseRefusedRenameNames(text: string): string[] {
  const names = new Set<string>()
  for (const m of text.matchAll(RENAME_PROMPT_RE)) {
    for (const line of m[1].split(/\r?\n/)) {
      const name = line.trim()
      if (/^[A-Za-z0-9_-]+$/.test(name)) names.add(name)
    }
  }
  return [...names]
}

function runEditor(
  spawnFn: SpawnFn,
  killTree: (proc: ChildProcess) => void,
  cmd: string,
  args: string[],
  signal: AbortSignal | undefined
): Promise<EditorRun> {
  return new Promise<EditorRun>((resolve) => {
    const buffer: string[] = []
    const tail = (): string => buffer.join('').split(/\r?\n/).slice(-TAIL_LINES).join('\n')
    let proc: ChildProcess
    try {
      proc = spawnFn(cmd, args, { windowsHide: true })
    } catch (err) {
      resolve({
        exitCode: null,
        output: '',
        cancelled: false,
        error: err instanceof Error ? err.message : String(err)
      })
      return
    }
    let cancelled = false
    let settled = false
    const onAbort = (): void => {
      cancelled = true
      try {
        killTree(proc)
      } catch (err) {
        console.warn('[relocate] kill failed:', err)
      }
    }
    const finish = (r: EditorRun): void => {
      if (settled) return
      settled = true
      signal?.removeEventListener('abort', onAbort)
      resolve(r)
    }
    // The rename prompt can scroll out of the bounded tail, so its asset names
    // are collected as the output streams by.
    const refusedNames = new Set<string>()
    let scan = ''
    const onData = (chunk: Buffer): void => {
      const text = chunk.toString('utf-8')
      buffer.push(text)
      // Same bounded tail as cleanupRedirectors: the editor log can be huge.
      if (buffer.length > 400) buffer.splice(0, buffer.length - 400)
      scan += text
      for (const n of parseRefusedRenameNames(scan)) refusedNames.add(n)
      if (scan.length > 16384) scan = scan.slice(-4096)
    }
    proc.stdout?.on('data', onData)
    proc.stderr?.on('data', onData)
    proc.on('close', (exitCode: number | null) =>
      finish({ exitCode, output: tail(), cancelled, refusedNames: [...refusedNames] })
    )
    proc.on('error', (err: Error) =>
      finish({
        exitCode: null,
        output: tail(),
        cancelled,
        error: err.message,
        refusedNames: [...refusedNames]
      })
    )
    if (signal) {
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
    }
  })
}

/** `/Mount/A/B` → `<mount dir>/A/B`; `null` for unknown mounts or unsafe segments. */
function ueToDisk(uePath: string, mounts: Map<string, string>): string | null {
  const [lead, mount, ...rest] = uePath.split('/')
  if (lead !== '' || !mount) return null
  if (rest.some((s) => s === '' || s === '.' || s === '..')) return null
  const base = mounts.get(mount)
  return base ? path.join(base, ...rest) : null
}

async function isDirectory(p: string): Promise<boolean> {
  try {
    return (await fsp.stat(p)).isDirectory()
  } catch {
    return false
  }
}

async function isFile(p: string): Promise<boolean> {
  try {
    return (await fsp.stat(p)).isFile()
  } catch {
    return false
  }
}

async function copyOne(
  src: string,
  dest: string,
  conflict: AddToProjectConflict,
  onFile: (kind: 'copied' | 'skipped', bytes: number) => void
): Promise<void> {
  try {
    await fsp.access(dest)
    if (conflict === 'skip') {
      onFile('skipped', 0)
      return
    }
  } catch {
    // Destination free.
  }
  await fsp.mkdir(path.dirname(dest), { recursive: true })
  await fsp.copyFile(src, dest)
  onFile('copied', (await fsp.stat(dest)).size)
}

/** Every file under `root` as `/`-separated relative paths. */
async function listFiles(root: string): Promise<string[]> {
  const out: string[] = []
  async function walk(dir: string, rel: string[]): Promise<void> {
    let entries
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (e.isDirectory()) await walk(path.join(dir, e.name), [...rel, e.name])
      else if (e.isFile()) out.push([...rel, e.name].join('/'))
    }
  }
  await walk(root, [])
  return out
}

export async function relocatePackIntoProject(
  req: RelocateRequest,
  deps: RelocateDeps,
  onStage: (stage: RelocateStage) => void,
  signal?: AbortSignal
): Promise<AddToProjectResult> {
  const cancelledResult: AddToProjectResult = { ok: false, cancelled: true, error: 'Cancelled' }
  if (!JOB_ID_RE.test(req.jobId)) return { ok: false, error: 'Invalid relocation job id' }
  const spawnFn = deps.spawn ?? nodeSpawn
  const killTree = deps.killTree ?? ((proc: ChildProcess): void => killProcessTree(proc))

  // Prepare: everything that can fail without side effects goes first.
  onStage('prepare')
  let targetUproject: unknown
  try {
    targetUproject = JSON.parse(
      (await fsp.readFile(req.uprojectPath, 'utf-8')).replace(/^\uFEFF/, '')
    )
  } catch (err) {
    return {
      ok: false,
      error: `Could not read the target .uproject: ${err instanceof Error ? err.message : String(err)}`
    }
  }
  const [topFolders, looseAssets, plugins, localPluginNames] = await Promise.all([
    listTopLevelFolders(req.sourceContentDir),
    listLoosePackages(req.sourceContentDir),
    listContentPlugins(req.projectDir),
    listProjectPluginNames(req.projectDir)
  ])
  const built = buildDestination({ destination: req.destination, topFolders, looseAssets, plugins })
  if (!built.ok) return { ok: false, error: built.error }
  const plan = built.plan
  const plugin = plan.pluginName ? plugins.find((p) => p.name === plan.pluginName) : undefined

  const editor = await deps.resolveEditor(req.uprojectPath)
  if ('error' in editor) return { ok: false, error: editor.error }
  if (signal?.aborted) return cancelledResult

  // Engine plugins the pack's native imports live in (Chaos Vehicles, Niagara,
  // ...). Without them the scratch editor can't load those assets and
  // rename_directory refuses the whole folder.
  const extraPlugins = editor.engineRoot
    ? await findPluginsForModules(editor.engineRoot, await findScriptModules(req.sourceContentDir))
    : []

  const scratch = path.join(deps.scratchRoot, req.jobId)
  const scratchContent = path.join(scratch, 'Content')
  const scratchUproject = path.join(scratch, 'Scratch.uproject')
  const scriptPath = path.join(scratch, 'relocate.py')
  const resultPath = path.join(scratch, 'result.json')
  let script = renderRelocateScript(plan, resultPath)

  const scratchMounts = new Map<string, string>([['Game', scratchContent]])
  const realMounts = new Map<string, string>([['Game', path.join(req.projectDir, 'Content')]])
  if (plugin) {
    scratchMounts.set(plugin.name, path.join(scratch, 'Plugins', plugin.name, 'Content'))
    realMounts.set(plugin.name, path.join(plugin.dir, 'Content'))
  }
  const scratchMount = scratchMounts.get(plugin ? plugin.name : 'Game') as string
  const realMount = realMounts.get(plugin ? plugin.name : 'Game') as string
  const relToDisk = (base: string, rel: string): string =>
    rel === '' ? base : path.join(base, ...rel.split('/'))

  try {
    await fsp.rm(scratch, { recursive: true, force: true })
    await fsp.mkdir(scratchContent, { recursive: true })
    await fsp.writeFile(
      scratchUproject,
      renderUproject({
        targetUproject,
        localPluginNames,
        stubPlugin: plugin?.name ?? null,
        extraPlugins
      }),
      'utf-8'
    )
    if (plugin) {
      const stubDir = path.join(scratch, 'Plugins', plugin.name)
      await fsp.mkdir(path.join(stubDir, 'Content'), { recursive: true })
      await fsp.writeFile(
        path.join(stubDir, `${plugin.name}.uplugin`),
        renderUpluginStub(plugin.name),
        'utf-8'
      )
    }
    await fsp.writeFile(scriptPath, script, 'utf-8')

    // Copy-in: the pack at its original /Game location.
    onStage('copy-in')
    await fsp.cp(req.sourceContentDir, scratchContent, { recursive: true })
    if (signal?.aborted) return cancelledResult

    // Editor: move, fix up references and save, headless.
    onStage('editor')
    const pythonArgs = [
      scratchUproject,
      '-run=pythonscript',
      `-script=${scriptPath}`,
      '-unattended',
      '-nullrhi',
      '-nosplash',
      '-nopause',
      // Without it the "Message dialog closed" line of the rename prompt (and
      // the asset names it lists) never reaches stdout.
      '-FullStdOutLogOutput'
    ]
    let run = await runEditor(spawnFn, killTree, editor.cmdExe, pythonArgs, signal)
    if (run.cancelled || signal?.aborted) return cancelledResult
    if (run.error) {
      return {
        ok: false,
        error: `Could not run ${editor.engineName}: ${run.error}`,
        output: run.output,
        script
      }
    }
    let outcome = await readScriptResult(resultPath)
    // A native CDO referencing some of the pack's assets makes the rename
    // manager ask "Continue with rename?", which unattended mode answers
    // Cancel for the whole batch (nothing changes). The prompt names those
    // assets: rerun once with them held back, to be moved by consolidation.
    // If the names could not be read, rerun splitting the batch instead.
    if (outcome?.refusedBatch) {
      const names = run.refusedNames ?? []
      script = renderRelocateScript(
        plan,
        resultPath,
        names.length > 0 ? { consolidate: names } : { bisect: true }
      )
      await fsp.writeFile(scriptPath, script, 'utf-8')
      await fsp.rm(resultPath, { force: true })
      run = await runEditor(spawnFn, killTree, editor.cmdExe, pythonArgs, signal)
      if (run.cancelled || signal?.aborted) return cancelledResult
      if (run.error) {
        return {
          ok: false,
          error: `Could not run ${editor.engineName}: ${run.error}`,
          output: run.output,
          script
        }
      }
      outcome = await readScriptResult(resultPath)
    }
    if (!outcome) {
      return {
        ok: false,
        error: `Unreal did not produce a result (exit code ${run.exitCode}). See the output for details.`,
        output: run.output,
        script
      }
    }
    if (!outcome.ok) {
      return {
        ok: false,
        error: `Relocation failed in Unreal: ${outcome.errors.join('; ') || 'unknown error'}`,
        output: run.output,
        script
      }
    }

    // Redirectors the script could not fix (older engines don't expose
    // fixup_referencers to Python, or a referencer refused): a second,
    // still headless pass with the stock commandlet rewrites the referencers
    // inside the scratch project and deletes the redirectors.
    if (outcome.redirectorsLeft > 0) {
      const fixup = await runEditor(
        spawnFn,
        killTree,
        editor.cmdExe,
        [
          scratchUproject,
          '-run=ResavePackages',
          '-fixupredirects',
          '-autocheckout',
          '-projectonly',
          '-unattended',
          '-nullrhi',
          '-nosplash',
          '-nopause'
        ],
        signal
      )
      if (fixup.cancelled || signal?.aborted) return cancelledResult
      const still: string[] = []
      for (const pkg of outcome.redirectors) {
        const onDisk = ueToDisk(pkg, scratchMounts)
        if (onDisk && (await isFile(`${onDisk}.uasset`))) still.push(pkg)
      }
      outcome.redirectors = still
      outcome.redirectorsLeft = still.length
    }

    // Copy-out: only the relocated subtree, with the user's conflict policy.
    onStage('copy-out')
    let filesCopied = 0
    let filesSkipped = 0
    let bytesCopied = 0
    const count = (kind: 'copied' | 'skipped', bytes: number): void => {
      if (kind === 'copied') {
        filesCopied += 1
        bytesCopied += bytes
      } else {
        filesSkipped += 1
      }
    }
    for (const rel of plan.copyOutRel) {
      const src = relToDisk(scratchMount, rel)
      if (!(await isDirectory(src))) continue
      await mergeDir(src, relToDisk(realMount, rel), req.conflict, count)
    }

    // Non-package files (movies, docs, ...) are not moved by Unreal: carry
    // them over from the source by path so e.g. media sources keep working.
    const folderTargets = new Map(
      plan.moves.filter((m) => m.kind === 'folder').map((m) => [m.from, m.to])
    )
    const subfolder = (req.destination.subfolder ?? '').trim()
    const baseUe = subfolder === '' ? mountRoot(plan.mount) : `${mountRoot(plan.mount)}/${subfolder}`
    for (const rel of await listFiles(req.sourceContentDir)) {
      if (PACKAGE_EXTS.includes(path.extname(rel).toLowerCase())) continue
      const segs = rel.split('/')
      if (EXTERNAL_FOLDERS.includes(segs[0])) continue
      const targetUe =
        segs.length === 1
          ? `${baseUe}/${segs[0]}`
          : `${folderTargets.get(`/Game/${segs[0]}`) ?? `${baseUe}/${segs[0]}`}/${segs.slice(1).join('/')}`
      const dest = ueToDisk(targetUe, realMounts)
      if (!dest) continue
      await copyOne(path.join(req.sourceContentDir, ...segs), dest, req.conflict, count)
    }

    // Redirectors Unreal could not fix up: keep them at their old path so
    // references still resolve, and tell the user to run Cleanup redirectors.
    for (const pkg of outcome.redirectors) {
      if (pkg === plan.destRoot || pkg.startsWith(`${plan.destRoot}/`)) continue
      const src = ueToDisk(pkg, scratchMounts)
      const dest = ueToDisk(pkg, realMounts)
      if (!src || !dest) continue
      try {
        await fsp.access(`${src}.uasset`)
      } catch {
        continue
      }
      await copyOne(`${src}.uasset`, `${dest}.uasset`, req.conflict, count)
    }

    const warnings: string[] = []
    if (outcome.redirectorsLeft > 0) {
      warnings.push(
        `${outcome.redirectorsLeft} redirector(s) could not be fixed up and were kept at their ` +
          'old location. Run "Cleanup redirectors" on the project.'
      )
    }
    if (run.exitCode !== 0) {
      const errors = summarizeEditorErrors(run.output)
      warnings.push(
        errors.length > 0
          ? `The move succeeded. While loading the pack Unreal also reported ${errors.length} ` +
              `error(s), usually problems of the pack itself (for example features removed in ` +
              `UE5): ${errors.slice(0, 3).join(' | ')}` +
              (errors.length > 3 ? ` (and ${errors.length - 3} more)` : '')
          : `Unreal reported success but ended with exit code ${run.exitCode}. Check the ` +
              "project's Output Log when you open it."
      )
    }
    return {
      ok: true,
      sourceContentDir: req.sourceContentDir,
      destContentDir: ueToDisk(plan.destRoot, realMounts) ?? realMount,
      destinationPath: plan.destRoot,
      filesCopied,
      filesSkipped,
      bytesCopied,
      warning: warnings.length > 0 ? warnings.join(' ') : undefined
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err), script }
  } finally {
    onStage('cleanup')
    try {
      // Retries: right after a kill Windows can hold file handles briefly.
      await fsp.rm(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
    } catch (err) {
      console.warn(`[relocate] could not remove scratch dir ${scratch}:`, err)
    }
  }
}
