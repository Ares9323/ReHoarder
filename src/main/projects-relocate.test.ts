import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { promises as fsp } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { ChildProcess } from 'node:child_process'
import {
  killProcessTree,
  relocatePackIntoProject,
  summarizeEditorErrors,
  type RelocateDeps,
  type RelocateRequest,
  type RelocateStage
} from './projects-relocate'

let tmp: string
beforeEach(async () => {
  tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'rehoarder-reloc-'))
})
afterEach(async () => {
  await fsp.rm(tmp, { recursive: true, force: true })
})

async function touch(p: string, content = 'x'): Promise<void> {
  await fsp.mkdir(path.dirname(p), { recursive: true })
  await fsp.writeFile(p, content)
}

async function exists(p: string): Promise<boolean> {
  try {
    await fsp.access(p)
    return true
  } catch {
    return false
  }
}

type Mode = 'ok' | 'fail' | 'noresult' | 'hang'

interface FakeEditor {
  spawn: NonNullable<RelocateDeps['spawn']>
  killTree: NonNullable<RelocateDeps['killTree']>
  calls: Array<{ cmd: string; args: string[] }>
  killed: number
  /** Snapshot of the scratch project taken when the editor was spawned. */
  seen: { uproject?: unknown; uplugin?: unknown; script?: string }
}

const PACKAGE_EXTS = ['.uasset', '.umap', '.uexp', '.ubulk']

/**
 * Stand-in for `UnrealEditor-Cmd.exe`: reads the plan out of relocate.py and
 * moves the package files like the script's batched `rename_assets` would (non-package files
 * stay behind, as in Unreal), then writes result.json.
 */
function fakeEditor(
  mode: Mode,
  opts: {
    exitCode?: number
    redirectors?: string[]
    resaveKeepsRedirectors?: boolean
    /** First run: print Unreal's CDO prompt naming these and refuse the whole batch. */
    refuseFirstRunWith?: string[]
  } = {}
): FakeEditor {
  let runs = 0
  const fake: FakeEditor = {
    calls: [],
    killed: 0,
    seen: {},
    spawn: undefined as never,
    killTree: undefined as never
  }
  let current: (EventEmitter & { pid: number }) | null = null
  fake.killTree = (proc: ChildProcess): void => {
    fake.killed += 1
    expect(proc).toBe(current)
    setImmediate(() => current!.emit('close', 1))
  }
  fake.spawn = ((cmd: string, args: string[]) => {
    fake.calls.push({ cmd, args })
    const proc = Object.assign(new EventEmitter(), {
      pid: 4242,
      stdout: new EventEmitter(),
      stderr: new EventEmitter()
    })
    current = proc
    void (async () => {
      const uprojectPath = args[0]
      const scratch = path.dirname(uprojectPath)
      if (args.includes('-run=ResavePackages')) {
        // ResavePackages -fixupredirects: rewrites referencers and deletes
        // the redirector packages, unless the test says it can't.
        if (!opts.resaveKeepsRedirectors) {
          for (const r of opts.redirectors ?? []) {
            const [, , ...rest] = r.split('/')
            await fsp.rm(path.join(scratch, 'Content', ...rest) + '.uasset', { force: true })
          }
        }
        await new Promise((r) => setImmediate(r))
        proc.emit('close', 0)
        return
      }
      const scriptPath = args.find((a) => a.startsWith('-script='))!.slice('-script='.length)
      const script = await fsp.readFile(scriptPath, 'utf-8')
      fake.seen.script = script
      fake.seen.uproject = JSON.parse(await fsp.readFile(uprojectPath, 'utf-8'))
      const plan = JSON.parse(JSON.parse(script.match(/^PLAN = json\.loads\((".*")\)$/m)![1]))
      if (plan.pluginName) {
        const p = path.join(scratch, 'Plugins', plan.pluginName, `${plan.pluginName}.uplugin`)
        fake.seen.uplugin = JSON.parse(await fsp.readFile(p, 'utf-8'))
      }
      proc.stdout.emit('data', Buffer.from('LogInit: fake editor\nLogPython: [ReHoarder] go\n'))
      if (mode === 'hang') return
      runs += 1
      if (runs === 1 && opts.refuseFirstRunWith) {
        proc.stdout.emit(
          'data',
          Buffer.from(
            '[2026.09.25-00.03.28:354][  0]Message dialog closed, result: Cancel, title: Message, ' +
              'text: Source code, config INI, and text files may need Find/Replace for:\n\n\n' +
              opts.refuseFirstRunWith.join('\n') +
              '\n\nOtherwise assets can be missing from cooked builds. Continue with rename?\n'
          )
        )
        await fsp.writeFile(
          plan.resultPath,
          JSON.stringify({
            ok: false,
            refusedBatch: true,
            moved: 0,
            redirectorsLeft: 0,
            redirectors: [],
            errors: ['The rename was refused for the whole batch']
          })
        )
        proc.emit('close', 0)
        return
      }
      const toDisk = (ue: string): string => {
        const [, mount, ...rest] = ue.split('/')
        const base =
          mount === 'Game'
            ? path.join(scratch, 'Content')
            : path.join(scratch, 'Plugins', mount, 'Content')
        return path.join(base, ...rest)
      }
      let moved = 0
      if (mode === 'ok') {
        for (const m of plan.moves as Array<{ from: string; to: string; kind: string }>) {
          const src = toDisk(m.from)
          const dst = toDisk(m.to)
          if (m.kind === 'asset') {
            await fsp.mkdir(path.dirname(dst), { recursive: true })
            await fsp.rename(`${src}.uasset`, `${dst}.uasset`)
            moved += 1
            continue
          }
          const walk = async (dir: string): Promise<void> => {
            for (const e of await fsp.readdir(dir, { withFileTypes: true })) {
              const abs = path.join(dir, e.name)
              if (e.isDirectory()) await walk(abs)
              else if (PACKAGE_EXTS.includes(path.extname(e.name))) {
                const target = path.join(dst, path.relative(src, abs))
                await fsp.mkdir(path.dirname(target), { recursive: true })
                await fsp.rename(abs, target)
                moved += 1
              }
            }
          }
          await walk(src)
        }
        for (const r of opts.redirectors ?? []) await touch(`${toDisk(r)}.uasset`, 'redirector')
      }
      if (mode !== 'noresult') {
        await fsp.writeFile(
          plan.resultPath,
          JSON.stringify({
            ok: mode === 'ok',
            moved,
            redirectorsLeft: (opts.redirectors ?? []).length,
            redirectors: opts.redirectors ?? [],
            errors: mode === 'ok' ? [] : ['Could not move /Game/Rocks to /Game/X/Rocks']
          })
        )
      }
      proc.emit('close', opts.exitCode ?? 0)
    })()
    return proc as unknown as ChildProcess
  }) as NonNullable<RelocateDeps['spawn']>
  return fake
}

async function setupProject(): Promise<{ content: string; projectDir: string; uproject: string }> {
  const content = path.join(tmp, 'vault', 'Pack', 'data', 'Content')
  await touch(path.join(content, 'Rocks', 'Meshes', 'SM_Rock.uasset'))
  await touch(path.join(content, 'Rocks', 'Maps', 'Demo.umap'))
  await touch(path.join(content, 'Rocks', 'Movies', 'intro.mp4'))
  const projectDir = path.join(tmp, 'Proj')
  const uproject = path.join(projectDir, 'Proj.uproject')
  await touch(
    uproject,
    JSON.stringify({
      FileVersion: 3,
      EngineAssociation: '5.4',
      Plugins: [
        { Name: 'Water', Enabled: true },
        { Name: 'Art', Enabled: true }
      ]
    })
  )
  await touch(
    path.join(projectDir, 'Plugins', 'Group', 'Art', 'Art.uplugin'),
    JSON.stringify({ FileVersion: 3, CanContainContent: true })
  )
  return { content, projectDir, uproject }
}

function deps(fake: FakeEditor, over: Partial<RelocateDeps> = {}): RelocateDeps {
  return {
    scratchRoot: path.join(tmp, 'userData', 'relocate'),
    resolveEditor: async () => ({ cmdExe: 'C:/UE_5.4/UnrealEditor-Cmd.exe', engineName: 'UE 5.4' }),
    spawn: fake.spawn,
    killTree: fake.killTree,
    ...over
  }
}

function request(
  p: { content: string; projectDir: string; uproject: string },
  over: Partial<RelocateRequest> = {}
): RelocateRequest {
  return {
    jobId: 'job1',
    sourceContentDir: p.content,
    projectDir: p.projectDir,
    uprojectPath: p.uproject,
    conflict: 'skip',
    destination: { mount: 'game', subfolder: 'ThirdParty' },
    ...over
  }
}

describe('summarizeEditorErrors', () => {
  it('lists the unique errors from the commandlet summary with their asset names', () => {
    const out = [
      '[..][  0]LogBlueprint: Error: [AssetLog] C:\\x\\Content\\Pack\\Maps\\Showcase.umap: [Compiler] Cannot use the editor function "Play" in this runtime Blueprint. from Source: /Game/Pack/Maps/Showcase',
      '[..][  0]LogInit: Display: Warning/Error Summary (Unique only)',
      '[..][  0]LogInit: Display: -----------------------------------',
      '[..][  0]LogInit: Display: LogBlueprint: Error: [AssetLog] C:\\x\\Content\\Pack\\Maps\\Showcase.umap: [Compiler] Cannot use the editor function "Play" in this runtime Blueprint. from Source: /Game/Pack/Maps/Showcase',
      '[..][  0]LogInit: Display: LogBlueprint: Warning: [AssetLog] C:\\x\\BP.uasset: [Compiler] unsafe',
      '[..][  0]LogInit: Display: Failure - 1 error(s), 7 warning(s)'
    ].join('\n')
    expect(summarizeEditorErrors(out)).toEqual([
      'Showcase: Cannot use the editor function "Play" in this runtime Blueprint.'
    ])
  })

  it('returns nothing when the summary has no errors', () => {
    expect(summarizeEditorErrors('LogInit: Display: Success - 0 error(s), 3 warning(s)')).toEqual([])
  })
})

describe('relocatePackIntoProject', () => {
  it('enables the engine plugins whose modules the pack imports', async () => {
    const p = await setupProject()
    await touch(
      path.join(p.content, 'Rocks', 'Blueprints', 'BP_Truck.uasset'),
      'hdr\u0000/Script/ChaosVehicles\u0000'
    )
    const engineRoot = path.join(tmp, 'UE_5.7')
    await touch(
      path.join(engineRoot, 'Engine', 'Plugins', 'Experimental', 'ChaosVehiclesPlugin', 'ChaosVehiclesPlugin.uplugin'),
      JSON.stringify({ Modules: [{ Name: 'ChaosVehicles' }] })
    )
    const fake = fakeEditor('ok')
    const r = await relocatePackIntoProject(
      request(p),
      deps(fake, {
        resolveEditor: async () => ({
          cmdExe: 'C:/UE_5.7/UnrealEditor-Cmd.exe',
          engineName: 'UE 5.7',
          engineRoot
        })
      }),
      () => {}
    )
    expect(r.ok, r.error).toBe(true)
    const plugins = (fake.seen.uproject as { Plugins: Array<{ Name: string; Enabled: boolean }> })
      .Plugins
    expect(plugins).toContainEqual({ Name: 'ChaosVehiclesPlugin', Enabled: true })
  })

  it('relocates under /Game/<subfolder>, reports stages in order and removes the scratch project', async () => {
    const p = await setupProject()
    const fake = fakeEditor('ok')
    const stages: RelocateStage[] = []
    const r = await relocatePackIntoProject(request(p), deps(fake), (s) => stages.push(s))

    expect(r.ok, r.error).toBe(true)
    expect(stages).toEqual(['prepare', 'copy-in', 'editor', 'copy-out', 'cleanup'])
    const dest = path.join(p.projectDir, 'Content', 'ThirdParty', 'Rocks')
    expect(await exists(path.join(dest, 'Meshes', 'SM_Rock.uasset'))).toBe(true)
    expect(await exists(path.join(dest, 'Maps', 'Demo.umap'))).toBe(true)
    // Non-package files are carried over from the source by path.
    expect(await exists(path.join(dest, 'Movies', 'intro.mp4'))).toBe(true)
    expect(r.filesCopied).toBe(3)
    expect(r.destinationPath).toBe('/Game/ThirdParty')
    expect(r.destContentDir).toBe(path.join(p.projectDir, 'Content', 'ThirdParty'))
    expect(r.warning).toBeUndefined()
    // Nothing leaks to the old location.
    expect(await exists(path.join(p.projectDir, 'Content', 'Rocks'))).toBe(false)
    expect(await exists(path.join(tmp, 'userData', 'relocate', 'job1'))).toBe(false)

    const scratch = path.join(tmp, 'userData', 'relocate', 'job1')
    expect(fake.calls).toEqual([
      {
        cmd: 'C:/UE_5.4/UnrealEditor-Cmd.exe',
        args: [
          path.join(scratch, 'Scratch.uproject'),
          '-run=pythonscript',
          `-script=${path.join(scratch, 'relocate.py')}`,
          '-unattended',
          '-nullrhi',
          '-nosplash',
          '-nopause',
          // Needed to see Unreal's rename prompt (and the names it lists) on stdout.
          '-FullStdOutLogOutput'
        ]
      }
    ])
    expect(fake.seen.uproject).toMatchObject({ EngineAssociation: '5.4' })
    const names = (fake.seen.uproject as { Plugins: Array<{ Name: string }> }).Plugins.map(
      (x) => x.Name
    )
    // The project-local plugin is not inherited (it doesn't exist in the scratch project).
    expect(names).toEqual(['Water', 'PythonScriptPlugin', 'EditorScriptingUtilities'])
  })

  it('relocates into a content plugin with a rename via a stub plugin', async () => {
    const p = await setupProject()
    const fake = fakeEditor('ok')
    const r = await relocatePackIntoProject(
      request(p, { destination: { mount: { plugin: 'Art' }, rename: 'Stones' } }),
      deps(fake),
      () => {}
    )
    expect(r.ok, r.error).toBe(true)
    expect(fake.seen.uplugin).toMatchObject({ CanContainContent: true })
    const pluginContent = path.join(p.projectDir, 'Plugins', 'Group', 'Art', 'Content')
    expect(await exists(path.join(pluginContent, 'Stones', 'Meshes', 'SM_Rock.uasset'))).toBe(true)
    expect(await exists(path.join(pluginContent, 'Stones', 'Movies', 'intro.mp4'))).toBe(true)
    expect(r.destinationPath).toBe('/Art')
  })

  it('honours the skip conflict policy on copy-out', async () => {
    const p = await setupProject()
    const existing = path.join(p.projectDir, 'Content', 'ThirdParty', 'Rocks', 'Maps', 'Demo.umap')
    await touch(existing, 'keep me')
    const r = await relocatePackIntoProject(request(p), deps(fakeEditor('ok')), () => {})
    expect(r.ok).toBe(true)
    expect(r.filesSkipped).toBe(1)
    expect(await fsp.readFile(existing, 'utf-8')).toBe('keep me')
  })

  it('overwrites on copy-out when asked', async () => {
    const p = await setupProject()
    const existing = path.join(p.projectDir, 'Content', 'ThirdParty', 'Rocks', 'Maps', 'Demo.umap')
    await touch(existing, 'old')
    const r = await relocatePackIntoProject(
      request(p, { conflict: 'overwrite' }),
      deps(fakeEditor('ok')),
      () => {}
    )
    expect(r.ok).toBe(true)
    expect(await fsp.readFile(existing, 'utf-8')).toBe('x')
  })

  it('fails with the output and script when the script reports ok: false, leaving the project untouched', async () => {
    const p = await setupProject()
    const stages: RelocateStage[] = []
    const r = await relocatePackIntoProject(request(p), deps(fakeEditor('fail')), (s) =>
      stages.push(s)
    )
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/Could not move/)
    expect(r.output).toMatch(/fake editor/)
    expect(r.script).toMatch(/rename_assets/)
    expect(stages).toEqual(['prepare', 'copy-in', 'editor', 'cleanup'])
    expect(await exists(path.join(p.projectDir, 'Content'))).toBe(false)
    expect(await exists(path.join(tmp, 'userData', 'relocate', 'job1'))).toBe(false)
  })

  it('fails when result.json is missing', async () => {
    const p = await setupProject()
    const r = await relocatePackIntoProject(
      request(p),
      deps(fakeEditor('noresult', { exitCode: 3 })),
      () => {}
    )
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/exit code 3/)
    expect(await exists(path.join(p.projectDir, 'Content'))).toBe(false)
  })

  it('succeeds with a warning and copies left-over redirectors when some remain', async () => {
    const p = await setupProject()
    const r = await relocatePackIntoProject(
      request(p),
      deps(
        fakeEditor('ok', {
          redirectors: ['/Game/Rocks/Meshes/SM_Old'],
          resaveKeepsRedirectors: true
        })
      ),
      () => {}
    )
    expect(r.ok).toBe(true)
    expect(r.warning).toMatch(/Cleanup redirectors/)
    expect(
      await exists(path.join(p.projectDir, 'Content', 'Rocks', 'Meshes', 'SM_Old.uasset'))
    ).toBe(true)
  })

  it('reruns with the prompt-refused assets held back when the whole batch is refused', async () => {
    const p = await setupProject()
    const fake = fakeEditor('ok', { refuseFirstRunWith: ['SM_Rock'] })
    const r = await relocatePackIntoProject(request(p), deps(fake), () => {})
    expect(r.ok, r.error).toBe(true)
    expect(fake.calls).toHaveLength(2)
    const plan = JSON.parse(JSON.parse(fake.seen.script!.match(/^PLAN = json\.loads\((".*")\)$/m)![1]))
    expect(plan.consolidate).toEqual(['SM_Rock'])
  })

  it('reruns in bisect mode when the batch is refused but the prompt names are not readable', async () => {
    const p = await setupProject()
    const fake = fakeEditor('ok', { refuseFirstRunWith: [] })
    const r = await relocatePackIntoProject(request(p), deps(fake), () => {})
    expect(r.ok, r.error).toBe(true)
    expect(fake.calls).toHaveLength(2)
    const plan = JSON.parse(JSON.parse(fake.seen.script!.match(/^PLAN = json\.loads\((".*")\)$/m)![1]))
    expect(plan.consolidate).toEqual([])
    expect(plan.bisect).toBe(true)
  })

  it('runs ResavePackages -fixupredirects on the scratch project when redirectors are left', async () => {
    const p = await setupProject()
    const fake = fakeEditor('ok', { redirectors: ['/Game/Rocks/Meshes/SM_Old'] })
    const r = await relocatePackIntoProject(request(p), deps(fake), () => {})
    expect(r.ok, r.error).toBe(true)
    expect(fake.calls).toHaveLength(2)
    expect(fake.calls[1].args).toEqual(
      expect.arrayContaining(['-run=ResavePackages', '-fixupredirects', '-unattended'])
    )
    // Fixed up in the scratch project: nothing left to copy, nothing to warn about.
    expect(r.warning).toBeUndefined()
    expect(
      await exists(path.join(p.projectDir, 'Content', 'Rocks', 'Meshes', 'SM_Old.uasset'))
    ).toBe(false)
  })

  it('succeeds with a warning when the editor exits non-zero after a good result', async () => {
    const p = await setupProject()
    const r = await relocatePackIntoProject(
      request(p),
      deps(fakeEditor('ok', { exitCode: 1 })),
      () => {}
    )
    expect(r.ok).toBe(true)
    expect(r.warning).toMatch(/exit code 1/)
  })

  it('kills the editor tree on cancel and cleans up without touching the project', async () => {
    const p = await setupProject()
    const fake = fakeEditor('hang')
    const ac = new AbortController()
    const stages: RelocateStage[] = []
    const r = await relocatePackIntoProject(request(p), deps(fake), (s) => {
      stages.push(s)
      if (s === 'editor') setTimeout(() => ac.abort(), 20)
    }, ac.signal)
    expect(r.ok).toBe(false)
    expect(r.cancelled).toBe(true)
    expect(fake.killed).toBe(1)
    expect(stages.at(-1)).toBe('cleanup')
    expect(await exists(path.join(p.projectDir, 'Content'))).toBe(false)
    expect(await exists(path.join(tmp, 'userData', 'relocate', 'job1'))).toBe(false)
  })

  it('returns cancelled without spawning when aborted before the editor step', async () => {
    const p = await setupProject()
    const fake = fakeEditor('ok')
    const ac = new AbortController()
    ac.abort()
    const r = await relocatePackIntoProject(request(p), deps(fake), () => {}, ac.signal)
    expect(r.cancelled).toBe(true)
    expect(fake.calls).toHaveLength(0)
    expect(await exists(path.join(tmp, 'userData', 'relocate', 'job1'))).toBe(false)
  })

  it('fails before creating anything on engine or destination errors', async () => {
    const p = await setupProject()
    const fake = fakeEditor('ok')
    const noEngine = await relocatePackIntoProject(
      request(p),
      deps(fake, { resolveEditor: async () => ({ error: 'No engine matching "5.4"' }) }),
      () => {}
    )
    expect(noEngine.ok).toBe(false)
    expect(noEngine.error).toMatch(/No engine/)

    const badPlugin = await relocatePackIntoProject(
      request(p, { destination: { mount: { plugin: 'Gone' } } }),
      deps(fake),
      () => {}
    )
    expect(badPlugin.ok).toBe(false)
    expect(badPlugin.error).toMatch(/Gone/)

    const badJob = await relocatePackIntoProject(request(p, { jobId: '../x' }), deps(fake), () => {})
    expect(badJob.ok).toBe(false)

    expect(fake.calls).toHaveLength(0)
    expect(await exists(path.join(tmp, 'userData', 'relocate'))).toBe(false)
  })

  it('killProcessTree uses taskkill /T /F on Windows and SIGKILL elsewhere', () => {
    const spawnFn = vi.fn()
    const kill = vi.fn()
    const proc = { pid: 77, kill } as unknown as ChildProcess
    killProcessTree(proc, 'win32', spawnFn as never)
    expect(spawnFn).toHaveBeenCalledWith('taskkill', ['/pid', '77', '/T', '/F'], {
      windowsHide: true
    })
    expect(kill).not.toHaveBeenCalled()
    killProcessTree(proc, 'linux', spawnFn as never)
    expect(kill).toHaveBeenCalledWith('SIGKILL')
  })
})
