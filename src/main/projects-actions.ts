import { spawn } from 'node:child_process'
import { promises as fsp } from 'node:fs'
import * as path from 'node:path'
import { scanEngines, type EngineInfo } from './engines-local'

/**
 * Project Quick Actions: Cleanup Redirectors (UE commandlet), Clean build
 * artifacts (silent rm of transient folders), Deep clean (rm with a user-
 * driven preserve set). Each function operates on a single project rooted at
 * `projectDir` (= the folder containing the `.uproject`), reuses the same
 * engine-resolution path the `run-game` IPC uses for the commandlet, and
 * returns a structured summary so the renderer can flash a toast like
 * "Freed 2.1 GB across 4 paths".
 *
 * Path safety: callers are expected to guard `projectDir` against the
 * configured `projectPaths` allow-list before dispatching. We don't re-guard
 * inside the helpers — they only ever touch known subdirectories of the
 * caller-supplied root, and `safeRm` refuses anything that escapes it.
 */

export interface CleanupRedirectorsResult {
  ok: boolean
  error?: string
  /** Exit code reported by `UnrealEditor-Cmd.exe`; `null` when the process never started. */
  exitCode: number | null
  /** Last ~200 lines of stdout/stderr concatenated — surfaced to the renderer for the user to inspect failure cases. */
  output: string
  /** Friendly name of the engine that ran the commandlet. */
  engineName?: string
}

export interface CleanSummary {
  /** Sum of all bytes removed across the deleted entries. */
  deletedBytes: number
  /** Absolute paths that were actually removed (skipped non-existent ones are not listed). */
  deletedPaths: string[]
  /** Absolute paths that were preserved per the user's selection (only set on Deep clean). */
  preservedPaths?: string[]
}

export interface CleanResult {
  ok: boolean
  error?: string
  summary: CleanSummary
}

/** What the renderer can ask Deep clean to keep inside `Saved/`. */
export interface DeepCleanPreserve {
  /** `Saved/Config/` — folder colors, layout, EditorPerProjectUserSettings, plugin INIs. */
  editorPreferences: boolean
  /** `Saved/Collections/` — named asset collections (`.collection` files). */
  assetCollections: boolean
  /** `Saved/SaveGames/` — runtime save games. */
  saveGames: boolean
  /** `Saved/AutoScreenshot.png` — used by ReHoarder as the project card thumbnail. */
  projectThumbnail: boolean
  /** `Saved/StagedBuilds/` + `Saved/LocalBuilds/` — packaged output (can be GBs). */
  localPackagedBuilds: boolean
}

/** Top-level project folders nuked by both clean variants. */
const TOP_LEVEL_TRASH = ['Binaries', 'Intermediate', 'DerivedDataCache', '.vs']

/** Subfolders of `Saved/` that are always transient — nuked by both variants. */
const SAVED_TRANSIENT = [
  'Crashes',
  'Logs',
  'Autosaves',
  'Backup',
  'Cooked',
  'SourceControl'
]

/**
 * Entries inside `Saved/` whose fate is driven by a user-facing preserve
 * checkbox. When the toggle is on → preserve. When it's off → DELETE
 * (the user explicitly opted to wipe that category). Genuinely-unknown
 * entries (plugin caches, ShaderDebugInfo, UnrealBuildTool, …) fall outside
 * this list and stay preserved as a safety default — better to surprise
 * the user with "BlueprintAssist/ is still there" than to silently nuke
 * a plugin's persistent state.
 */
const SAVED_MANAGED_BY_TOGGLE = [
  'Config',
  'Collections',
  'SaveGames',
  'AutoScreenshot.png',
  'StagedBuilds',
  'LocalBuilds'
]

/**
 * Resolve a project's engine association to a packaged-engine record. Mirrors
 * the lookup in `projects:run-game`: short version slug (`5.7`, `4.27`)
 * matched against `engines.version`'s major.minor. GUID-based source-build
 * associations are not yet supported.
 */
async function resolveEngineForProject(
  uprojectPath: string,
  enginePaths: string[]
): Promise<{ engine: EngineInfo } | { error: string }> {
  let raw: string
  try {
    raw = await fsp.readFile(uprojectPath, 'utf-8')
  } catch (err) {
    return { error: `Could not read .uproject: ${err instanceof Error ? err.message : String(err)}` }
  }
  let assoc: string
  try {
    assoc = (JSON.parse(raw) as { EngineAssociation?: string }).EngineAssociation ?? ''
  } catch {
    return { error: 'Could not parse .uproject as JSON' }
  }
  if (!assoc) return { error: 'The .uproject has no EngineAssociation field' }
  if (assoc.startsWith('{')) {
    return { error: 'Source-build EngineAssociation (GUID) is not yet supported by this action' }
  }
  const engines = await scanEngines(enginePaths)
  const engine = engines.find((e) => e.version.split('.').slice(0, 2).join('.') === assoc)
  if (!engine) return { error: `No engine matching "${assoc}" in the configured engine paths` }
  return { engine }
}

/**
 * Spawn `UnrealEditor-Cmd.exe <uproject> -run=ResavePackages -fixupredirects …`
 * and wait for completion. The commandlet walks every `.uasset` in the
 * project's `Content/`, follows ObjectRedirectors and rewrites the soft
 * references inline, then deletes the redirector itself — the canonical
 * batch-fix for "broken reference" warnings after asset rename / move.
 */
export async function cleanupRedirectors(
  uprojectPath: string,
  enginePaths: string[]
): Promise<CleanupRedirectorsResult> {
  const resolved = await resolveEngineForProject(uprojectPath, enginePaths)
  if ('error' in resolved) {
    return { ok: false, error: resolved.error, exitCode: null, output: '' }
  }
  const { engine } = resolved
  // `editorExePath` points at `UnrealEditor.exe`; the commandlet runner is
  // `UnrealEditor-Cmd.exe` next to it. Falling back to the editor exe still
  // works on most UE versions but produces a flickering splash on Windows.
  let cmdExe: string | null = null
  if (engine.editorExePath) {
    const parent = path.dirname(engine.editorExePath)
    const cmd = path.join(parent, 'UnrealEditor-Cmd.exe')
    try {
      await fsp.access(cmd)
      cmdExe = cmd
    } catch {
      cmdExe = engine.editorExePath
    }
  }
  if (!cmdExe) {
    return {
      ok: false,
      error: `Engine ${engine.name} has no editor executable on disk`,
      exitCode: null,
      output: '',
      engineName: engine.name
    }
  }
  const args = [
    uprojectPath,
    '-run=ResavePackages',
    '-fixupredirects',
    '-autocheckout',
    '-projectonly',
    '-unattended'
  ]
  return new Promise<CleanupRedirectorsResult>((resolve) => {
    const buffer: string[] = []
    const proc = spawn(cmdExe!, args, { windowsHide: true })
    const onLine = (chunk: Buffer): void => {
      const text = chunk.toString('utf-8')
      buffer.push(text)
      // Keep memory bounded — the commandlet can produce tens of MB on a
      // large project. We surface the tail so error context is preserved
      // without buffering the entire transcript.
      if (buffer.length > 400) buffer.splice(0, buffer.length - 400)
    }
    proc.stdout.on('data', onLine)
    proc.stderr.on('data', onLine)
    proc.on('close', (exitCode) => {
      resolve({
        ok: exitCode === 0,
        error:
          exitCode === 0
            ? undefined
            : `Commandlet exited with code ${exitCode}. See output for details.`,
        exitCode,
        output: buffer.join('').split(/\r?\n/).slice(-200).join('\n'),
        engineName: engine.name
      })
    })
    proc.on('error', (err) => {
      resolve({
        ok: false,
        error: err.message,
        exitCode: null,
        output: buffer.join(''),
        engineName: engine.name
      })
    })
  })
}

/**
 * The "always safe to nuke" sweep. Removes:
 *   - top-level `Binaries/`, `Intermediate/`, `DerivedDataCache/`, `.vs/`
 *   - transient sub-folders of `Saved/` (crashes, logs, autosaves, backup, cooked, source control)
 *   - `Saved/StagedBuilds/` + `Saved/LocalBuilds/` (packaged output)
 *
 * Always preserved: `Saved/Config/`, `Saved/Collections/`, `Saved/SaveGames/`,
 * `Saved/AutoScreenshot.png`. Equivalent to Deep clean with every preserve
 * checkbox on (and Local packaged builds off — its default).
 */
export async function cleanBuildArtifacts(projectDir: string): Promise<CleanResult> {
  return deepCleanProject(projectDir, {
    editorPreferences: true,
    assetCollections: true,
    saveGames: true,
    projectThumbnail: true,
    localPackagedBuilds: false
  })
}

/**
 * Smart-wipe `projectDir` honouring a user-controlled preserve set inside
 * `Saved/`. Top-level trash + Saved/ transient folders are always removed;
 * `Saved/` entries outside the always-transient list are preserved when
 * their toggle is on.
 */
export async function deepCleanProject(
  projectDir: string,
  preserve: DeepCleanPreserve
): Promise<CleanResult> {
  const deleted: string[] = []
  const preserved: string[] = []
  let deletedBytes = 0

  for (const sub of TOP_LEVEL_TRASH) {
    const target = path.join(projectDir, sub)
    const bytes = await rmIfExists(target, projectDir)
    if (bytes !== null) {
      deleted.push(target)
      deletedBytes += bytes
    }
  }

  const savedDir = path.join(projectDir, 'Saved')
  let savedEntries: string[]
  try {
    savedEntries = await fsp.readdir(savedDir)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { ok: true, summary: { deletedBytes, deletedPaths: deleted, preservedPaths: preserved } }
    }
    return {
      ok: false,
      error: `Could not read Saved/: ${err instanceof Error ? err.message : String(err)}`,
      summary: { deletedBytes, deletedPaths: deleted, preservedPaths: preserved }
    }
  }
  for (const entry of savedEntries) {
    const target = path.join(savedDir, entry)
    // Entries explicitly governed by a checkbox: the toggle wins. If the user
    // turned `Editor preferences` off, `Config/` MUST be nuked — without this
    // branch the fall-through "unknown → preserve" safety net would keep it
    // alive against the user's intent.
    if (SAVED_MANAGED_BY_TOGGLE.includes(entry)) {
      if (shouldPreserveSavedEntry(entry, preserve)) {
        preserved.push(target)
      } else {
        const bytes = await rmIfExists(target, projectDir)
        if (bytes !== null) {
          deleted.push(target)
          deletedBytes += bytes
        }
      }
      continue
    }
    if (SAVED_TRANSIENT.includes(entry) || isAlwaysTrashSavedEntry(entry)) {
      const bytes = await rmIfExists(target, projectDir)
      if (bytes !== null) {
        deleted.push(target)
        deletedBytes += bytes
      }
      continue
    }
    // Genuinely-unknown entries inside Saved/ (plugin caches, ShaderDebugInfo,
    // UnrealBuildTool, …): keep them. Better to surprise the user with
    // "Saved/BlueprintAssist is still there" than to silently nuke a plugin's
    // persistent data we don't know how to regenerate.
    preserved.push(target)
  }
  return { ok: true, summary: { deletedBytes, deletedPaths: deleted, preservedPaths: preserved } }
}

function shouldPreserveSavedEntry(entry: string, preserve: DeepCleanPreserve): boolean {
  if (entry === 'Config') return preserve.editorPreferences
  if (entry === 'Collections') return preserve.assetCollections
  if (entry === 'SaveGames') return preserve.saveGames
  if (entry === 'AutoScreenshot.png') return preserve.projectThumbnail
  if (entry === 'StagedBuilds' || entry === 'LocalBuilds') return preserve.localPackagedBuilds
  return false
}

function isAlwaysTrashSavedEntry(entry: string): boolean {
  // Loose `.tmp` files often left at the Saved/ root by import flows
  // (texture / mesh staging) — see the CityParkEnvLite sample we inspected.
  if (entry.toLowerCase().endsWith('.tmp')) return true
  // StagedBuilds / LocalBuilds are conditionally trashed (preserve toggle is
  // off by default). The branch above already returns the conditional;
  // returning false here means "fall through to the unknown-entry preserve".
  return false
}

/**
 * Best-effort recursive remove that aborts when the resolved target would
 * escape `projectDir`. Returns the byte count freed, or `null` when the
 * target didn't exist. Any other error propagates as a throw — callers wrap
 * it in their CleanResult.
 */
async function rmIfExists(target: string, projectDir: string): Promise<number | null> {
  const resolvedTarget = path.resolve(target)
  const resolvedRoot = path.resolve(projectDir)
  if (!resolvedTarget.startsWith(resolvedRoot + path.sep) && resolvedTarget !== resolvedRoot) {
    throw new Error(`Refusing to remove "${target}" — escapes project dir`)
  }
  let bytes = 0
  try {
    bytes = await sizeOf(resolvedTarget)
  } catch {
    return null
  }
  try {
    await fsp.rm(resolvedTarget, { recursive: true, force: true })
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
  return bytes
}

/**
 * Sum the byte size of a file-or-directory tree. Used to report freed-space
 * back to the renderer. Errors during the walk are swallowed per-entry —
 * transient files / permission glitches shouldn't fail the whole sum.
 */
async function sizeOf(target: string): Promise<number> {
  let total = 0
  let stat
  try {
    stat = await fsp.stat(target)
  } catch {
    return 0
  }
  if (stat.isFile()) return stat.size
  if (!stat.isDirectory()) return 0
  let entries
  try {
    entries = await fsp.readdir(target, { withFileTypes: true })
  } catch {
    return 0
  }
  await Promise.all(
    entries.map(async (e) => {
      const child = path.join(target, e.name)
      total += await sizeOf(child)
    })
  )
  return total
}
