import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import * as path from 'node:path'
import type { SettingsStore } from '../settings'

/**
 * Post-install bookkeeping for a freshly-downloaded Unreal Engine.
 *
 * Two things must happen after the chunk runner finishes for the engine to
 * be useful:
 *
 *  1. The engine's containing directory must be in `settings.enginePaths`
 *     so the Engines tab's rescan picks it up. Without this, the user has
 *     to manually add the path under Settings → Unreal Engine paths.
 *
 *  2. On Windows, the engine must be registered with `UnrealVersionSelector`
 *     under `HKCU\Software\Epic Games\Unreal Engine\Builds\{GUID}` so any
 *     `.uproject` with `EngineAssociation = "{GUID}"` resolves correctly
 *     when opened outside of ReHoarder. Launcher-installed engines write
 *     to `HKLM` (requires admin); the HKCU variant is the "source build"
 *     registration path that doesn't require elevation.
 *
 * On Linux/macOS we just do step 1 — UVS doesn't exist on those platforms
 * and the engine path goes straight in `enginePaths`.
 */

export interface PostInstallResult {
  /** Parent dir added to `enginePaths` (or already there). */
  enginePathAdded: string
  /** True when the path was already configured before this run. */
  enginePathAlreadyConfigured: boolean
  /** Stable GUID assigned to the engine on Windows (sha1 of `installDir`).
   *  `null` on non-Windows hosts where the registry step is skipped. */
  guid: string | null
  /** Outcome of the Windows registry write, when attempted. `null` means
   *  the step was skipped (non-Windows or not applicable). Errors are
   *  swallowed and reported here — the engine is still usable inside
   *  ReHoarder even if the registry write failed (we just lose the cross-
   *  app `.uproject` association). */
  registryStatus: 'ok' | 'skipped' | { error: string } | null
}

/**
 * Stable GUID derived from the install path so re-installing the same
 * engine to the same location reuses its registration instead of growing
 * a new HKCU entry every run.
 *
 * Format mirrors the GUID shape UnrealVersionSelector expects:
 * `{XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX}`. The bytes come from a SHA1
 * of the normalised path (case-folded on Windows) — collisions are
 * astronomically unlikely and a stable mapping is more valuable than
 * cryptographic uniqueness here.
 */
export function deriveEngineGuid(installDir: string): string {
  const normalised =
    process.platform === 'win32' ? installDir.toLowerCase() : installDir
  const hex = createHash('sha1').update(normalised).digest('hex')
  return (
    '{' +
    hex.slice(0, 8) +
    '-' +
    hex.slice(8, 12) +
    '-' +
    hex.slice(12, 16) +
    '-' +
    hex.slice(16, 20) +
    '-' +
    hex.slice(20, 32) +
    '}'
  )
}

/** Promise wrapper around `child_process.spawn` returning the exit code +
 *  collected stderr (so a non-zero exit surfaces a useful error). */
function runOnce(
  command: string,
  args: string[]
): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve) => {
    let stderr = ''
    const child = spawn(command, args, { windowsHide: true })
    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString()
    })
    child.on('close', (code) => resolve({ code: code ?? -1, stderr }))
    child.on('error', (err) => resolve({ code: -1, stderr: err.message }))
  })
}

/**
 * Write `HKCU\Software\Epic Games\Unreal Engine\Builds\{GUID}` =
 * `installDir`. Uses the bundled `reg.exe`, which writes to HKCU without
 * elevation. Returns an error string on failure (which is non-fatal —
 * `.uproject` files opened from inside ReHoarder still work without the
 * registry entry; the registration only matters for opening uprojects
 * with the OS file association from Explorer).
 */
async function registerEngineOnWindows(
  installDir: string,
  guid: string
): Promise<'ok' | { error: string }> {
  if (process.platform !== 'win32') return 'ok'
  const { code, stderr } = await runOnce('reg.exe', [
    'add',
    'HKCU\\Software\\Epic Games\\Unreal Engine\\Builds',
    '/v',
    guid,
    '/t',
    'REG_SZ',
    '/d',
    installDir,
    '/f'
  ])
  if (code !== 0) {
    return { error: `reg.exe exited ${code}: ${stderr.trim()}` }
  }
  return 'ok'
}

/**
 * Add `parentOfInstallDir` to `settings.enginePaths` when it isn't already
 * configured. Comparison is case-insensitive on Windows so a user who
 * picked `C:\Unreal` once and `c:\unreal` another time doesn't end up
 * with two equivalent rows.
 */
function appendEnginePathIfNew(
  settings: SettingsStore,
  parentDir: string
): { added: boolean } {
  const cfg = settings.load()
  const fold = process.platform === 'win32'
  const norm = (p: string): string => (fold ? p.toLowerCase() : p)
  const existing = cfg.enginePaths.map(norm)
  if (existing.includes(norm(parentDir))) {
    return { added: false }
  }
  settings.saveAll({
    ...cfg,
    enginePaths: [...cfg.enginePaths, parentDir]
  })
  return { added: true }
}

/**
 * Full post-install: register with UVS (Windows only) + add the parent
 * directory to `enginePaths`. Pure side-effect helper — caller is in
 * charge of broadcasting the "engine installed" event to the renderer.
 */
export async function finalizeEngineInstall(
  settings: SettingsStore,
  installDir: string
): Promise<PostInstallResult> {
  const parentDir = path.resolve(installDir, '..')
  const pathStatus = appendEnginePathIfNew(settings, parentDir)
  let guid: string | null = null
  let registryStatus: PostInstallResult['registryStatus'] = null
  if (process.platform === 'win32') {
    guid = deriveEngineGuid(installDir)
    registryStatus = await registerEngineOnWindows(installDir, guid)
  } else {
    registryStatus = 'skipped'
  }
  return {
    enginePathAdded: parentDir,
    enginePathAlreadyConfigured: !pathStatus.added,
    guid,
    registryStatus
  }
}
