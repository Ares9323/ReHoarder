import { spawn } from 'node:child_process'
import { promises as fsp } from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { writeFileSync, unlinkSync } from 'node:fs'
import { deriveEngineGuid } from './engine-downloads/engine-post-install'
import type { SettingsStore } from './settings'

/**
 * Engine-side counterpart to projects-actions.ts. Surfaces three context
 * actions to the renderer:
 *  - Uninstall engine (rm tree + dereg HKCU\…\Builds\{GUID})
 *  - Create shortcut on the desktop (.lnk via wscript-driven VBS on Windows;
 *    .desktop on Linux; .command alias on macOS would land later)
 *  - Set as default engine (lives in settings, no native OS hook)
 *
 * Each helper is path-guarded: callers are expected to validate the engine
 * root against `settings.enginePaths` first, but we double-check inside.
 */

export interface UninstallEngineResult {
  ok: boolean
  error?: string
  /** Total bytes removed from the engine directory tree. */
  bytesRemoved: number
  /** True when the matching HKCU\Software\Epic Games\Unreal Engine\Builds entry was deleted. */
  registryDeregistered: boolean
  /** True when the engine root's parent was pruned from `settings.enginePaths` (it was the only engine there). */
  enginePathRemoved: boolean
}

export interface CreateShortcutResult {
  ok: boolean
  error?: string
  /** Absolute path of the `.lnk` / `.desktop` we wrote. */
  shortcutPath?: string
}

/**
 * Recursively size a tree, swallowing per-entry errors so transient files
 * don't fail the whole sum. Mirrors `projects-actions.ts:sizeOf` — kept
 * inline because cross-module sharing would mean a tiny `fs-walk` helper
 * file that only has two callers.
 */
async function sizeOf(target: string): Promise<number> {
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
  let total = 0
  await Promise.all(
    entries.map(async (e) => {
      total += await sizeOf(path.join(target, e.name))
    })
  )
  return total
}

/**
 * Delete the engine directory + its HKCU registration (on Windows) and
 * optionally drop its parent from `settings.enginePaths` when it was the
 * only engine living there. Refuses to touch paths that aren't currently
 * under a configured engine root — guards against typo-driven `rm -rf C:\`
 * if the renderer ever sends a stale path.
 */
export async function uninstallEngine(
  settings: SettingsStore,
  engineRoot: string
): Promise<UninstallEngineResult> {
  const cfg = settings.load()
  const resolved = path.resolve(engineRoot)
  const fold = process.platform === 'win32'
  const norm = (p: string): string => (fold ? path.resolve(p).toLowerCase() : path.resolve(p))
  const insideConfigured = cfg.enginePaths.some((root) => {
    const rootNorm = norm(root)
    const candidate = fold ? resolved.toLowerCase() : resolved
    return candidate === rootNorm || candidate.startsWith(rootNorm + path.sep)
  })
  if (!insideConfigured) {
    return {
      ok: false,
      error: 'Engine path is outside the configured engine roots',
      bytesRemoved: 0,
      registryDeregistered: false,
      enginePathRemoved: false
    }
  }
  // Reject the root itself — uninstalling "C:\Program Files\Epic Games\"
  // would nuke every engine under it. Caller should pass the per-engine
  // folder (e.g. `C:\…\Epic Games\UE_5.5`).
  if (cfg.enginePaths.some((root) => norm(root) === norm(resolved))) {
    return {
      ok: false,
      error: 'Refusing to remove a configured engine root itself',
      bytesRemoved: 0,
      registryDeregistered: false,
      enginePathRemoved: false
    }
  }

  let bytesRemoved = 0
  try {
    bytesRemoved = await sizeOf(resolved)
  } catch {
    bytesRemoved = 0
  }
  try {
    await fsp.rm(resolved, { recursive: true, force: true })
  } catch (err) {
    return {
      ok: false,
      error: `Failed to remove ${resolved}: ${err instanceof Error ? err.message : String(err)}`,
      bytesRemoved: 0,
      registryDeregistered: false,
      enginePathRemoved: false
    }
  }

  // Dereg HKCU\Software\Epic Games\Unreal Engine\Builds\{GUID}. The GUID is
  // derived deterministically from the install path (same logic ReHoarder
  // uses on install), so we don't need a roundtrip through `reg.exe QUERY`
  // to find it. Failure to dereg is non-fatal — the engine binaries are
  // gone, the registry entry just dangles until the next install at a new
  // path reclaims its slot.
  let registryDeregistered = false
  if (process.platform === 'win32') {
    const guid = deriveEngineGuid(resolved)
    try {
      const exit = await runReg([
        'delete',
        'HKCU\\Software\\Epic Games\\Unreal Engine\\Builds',
        '/v',
        guid,
        '/f'
      ])
      registryDeregistered = exit === 0
    } catch {
      registryDeregistered = false
    }
  }

  // If the engine's parent directory now has zero remaining engines, drop
  // it from `settings.enginePaths` so the next scan doesn't waste time on
  // an empty folder. Uses `scanEngines`-style detection (Build.version
  // probe) without a full scan — readdir + check children.
  let enginePathRemoved = false
  const parentDir = path.dirname(resolved)
  const cfgAfter = settings.load()
  const matchingRoots = cfgAfter.enginePaths.filter((p) => norm(p) === norm(parentDir))
  if (matchingRoots.length > 0) {
    try {
      const siblings = await fsp.readdir(parentDir, { withFileTypes: true })
      let stillHasEngine = false
      for (const entry of siblings) {
        if (!entry.isDirectory()) continue
        const buildVer = path.join(parentDir, entry.name, 'Engine', 'Build', 'Build.version')
        try {
          await fsp.access(buildVer)
          stillHasEngine = true
          break
        } catch {
          // not an engine — keep looking
        }
      }
      if (!stillHasEngine) {
        settings.saveAll({
          ...cfgAfter,
          enginePaths: cfgAfter.enginePaths.filter((p) => norm(p) !== norm(parentDir))
        })
        enginePathRemoved = true
      }
    } catch {
      // best-effort cleanup — readdir failure shouldn't fail the uninstall
    }
  }

  return {
    ok: true,
    bytesRemoved,
    registryDeregistered,
    enginePathRemoved
  }
}

function runReg(args: string[]): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn('reg.exe', args, { windowsHide: true, stdio: 'ignore' })
    child.on('close', (code) => resolve(code ?? -1))
    child.on('error', () => resolve(-1))
  })
}

/**
 * Create a Windows `.lnk` pointing at `targetPath` on the user's Desktop
 * (or wherever `destDir` says). Driven through `wscript.exe` running a
 * temporary VBS that uses `WScript.Shell.CreateShortcut` — the canonical
 * Windows pattern that doesn't require native bindings or PowerShell
 * execution-policy concerns. Returns the absolute path of the .lnk on
 * success.
 *
 * `description` populates the .lnk's Comment field (visible in Properties
 * dialog). `iconPath` is optional; if set, points the .lnk's icon at a
 * specific .ico/.exe.
 */
export async function createWindowsShortcut(opts: {
  shortcutName: string
  targetPath: string
  workingDir?: string
  description?: string
  iconPath?: string
  destDir?: string
  args?: string
}): Promise<CreateShortcutResult> {
  if (process.platform !== 'win32') {
    return { ok: false, error: 'Windows shortcuts can only be created on Windows.' }
  }
  // Default destination: the current user's Desktop. `app.getPath('desktop')`
  // would be cleaner but pulls in Electron's app module here; resolving via
  // USERPROFILE is fine on every modern Windows.
  const desktop = opts.destDir ?? path.join(os.homedir(), 'Desktop')
  // Sanitise the .lnk filename — Windows forbids `<>:"/\|?*` plus reserved
  // names. We replace forbidden chars with `_` so the user's chosen name
  // survives most edge cases (engine version slugs, project names with
  // colons, etc.).
  const safeName = opts.shortcutName.replace(/[<>:"/\\|?* -]/g, '_').trim()
  if (!safeName) {
    return { ok: false, error: 'Shortcut name is empty after sanitisation.' }
  }
  const shortcutPath = path.join(desktop, safeName + '.lnk')

  // VBS double-quote escape is `""` for a literal `"`. Defensive even
  // though typical UE install paths don't contain quotes.
  const esc = (s: string): string => s.replace(/"/g, '""')
  const vbs =
    'Set objShell = WScript.CreateObject("WScript.Shell")\r\n' +
    `Set sc = objShell.CreateShortcut("${esc(shortcutPath)}")\r\n` +
    `sc.TargetPath = "${esc(opts.targetPath)}"\r\n` +
    (opts.args ? `sc.Arguments = "${esc(opts.args)}"\r\n` : '') +
    (opts.workingDir
      ? `sc.WorkingDirectory = "${esc(opts.workingDir)}"\r\n`
      : `sc.WorkingDirectory = "${esc(path.dirname(opts.targetPath))}"\r\n`) +
    (opts.description ? `sc.Description = "${esc(opts.description)}"\r\n` : '') +
    (opts.iconPath ? `sc.IconLocation = "${esc(opts.iconPath)}"\r\n` : '') +
    'sc.Save\r\n'
  const vbsPath = path.join(os.tmpdir(), `rehoarder-shortcut-${Date.now()}.vbs`)
  try {
    writeFileSync(vbsPath, vbs, 'utf-8')
  } catch (err) {
    return { ok: false, error: `Could not write VBS: ${err instanceof Error ? err.message : String(err)}` }
  }

  const code = await new Promise<number>((resolve) => {
    const child = spawn('wscript.exe', [vbsPath], {
      windowsHide: true,
      stdio: 'ignore'
    })
    child.on('close', (c) => resolve(c ?? -1))
    child.on('error', () => resolve(-1))
  })

  try {
    unlinkSync(vbsPath)
  } catch {
    // best-effort: the temp file is small and Windows %TEMP% cleanup will get to it
  }

  if (code !== 0) {
    return { ok: false, error: `wscript.exe exited with code ${code}` }
  }
  try {
    await fsp.access(shortcutPath)
  } catch {
    return { ok: false, error: 'Shortcut creation reported success but the file is missing.' }
  }
  return { ok: true, shortcutPath }
}
