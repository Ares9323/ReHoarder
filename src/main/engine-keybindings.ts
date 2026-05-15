import { promises as fsp } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  applyMerge,
  buildSentinelLine,
  computeMasterHash,
  hasSentinel,
  parseIni,
  serializeIni,
  stripSentinelHeader,
  summarisePatchResult,
  type PatchResult
} from './engine-ini-patcher'

/**
 * Master target for editor keybindings — analogous to engine-editor-settings.ts
 * but with a different file path. Where Base*UserSettings.ini lives under the
 * engine install, EditorKeyBindings.ini is **per-user, per-engine-version**
 * inside the OS-specific app-data area:
 *
 *   Windows  %LOCALAPPDATA%\UnrealEngine\<major.minor>\Saved\Config\WindowsEditor\EditorKeyBindings.ini
 *   macOS    ~/Library/Application Support/Epic/UnrealEngine/<major.minor>/Saved/Config/MacEditor/EditorKeyBindings.ini
 *   Linux    ~/.config/Epic/UnrealEngine/<major.minor>/Saved/Config/LinuxEditor/EditorKeyBindings.ini
 *
 * Side-effect of the location: multiple engine installs of the same version
 * (e.g. a source-build alongside the Launcher install) share the same file,
 * so the apply-to-all flow de-duplicates by version.
 */

const PLATFORM_EDITOR_DIR =
  process.platform === 'win32' ? 'WindowsEditor' : process.platform === 'darwin' ? 'MacEditor' : 'LinuxEditor'

/** Reduce `5.6.1` → `5.6`; preserve `5.6` and `5` as-is. */
export function shortEngineVersion(fullVersion: string): string {
  const parts = fullVersion.split('.').filter((s) => s.length > 0)
  if (parts.length === 0) return fullVersion
  if (parts.length === 1) return parts[0]
  return `${parts[0]}.${parts[1]}`
}

function appDataBase(): string {
  if (process.platform === 'win32') {
    return (
      process.env.LOCALAPPDATA ||
      path.join(os.homedir(), 'AppData', 'Local')
    )
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'Epic')
  }
  return process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config', 'Epic')
}

export function getKeyBindingsIniPath(engineVersionShort: string): string {
  return path.join(
    appDataBase(),
    'UnrealEngine',
    engineVersionShort,
    'Saved',
    'Config',
    PLATFORM_EDITOR_DIR,
    'EditorKeyBindings.ini'
  )
}

export function getKeyBindingsBackupPath(engineVersionShort: string): string {
  return getKeyBindingsIniPath(engineVersionShort) + '.bak'
}

export interface KeyBindingsInfo {
  /** Absolute path of the user-config keybindings file (may not exist yet). */
  iniPath: string
  hasSentinel: boolean
  hasBackup: boolean
  masterHash: string | null
}

export async function readKeyBindingsInfo(engineVersionShort: string): Promise<KeyBindingsInfo> {
  const iniPath = getKeyBindingsIniPath(engineVersionShort)
  let sentinel = false
  let masterHash: string | null = null
  try {
    const content = await fsp.readFile(iniPath, 'utf-8')
    if (hasSentinel(content)) {
      sentinel = true
      const first = content.split(/\r?\n/, 1)[0] ?? ''
      const m = /master:\s*([0-9a-f]+)/i.exec(first)
      if (m) masterHash = m[1]
    }
  } catch {
    /* file missing is fine — info reflects "no patch yet" */
  }
  let hasBak = false
  try {
    await fsp.access(getKeyBindingsBackupPath(engineVersionShort))
    hasBak = true
  } catch {
    /* no backup */
  }
  return { iniPath, hasSentinel: sentinel, hasBackup: hasBak, masterHash }
}

export interface ApplyKeyBindingsResult {
  ok: boolean
  error?: string
  iniPath?: string
  backupPath?: string
  backupWritten?: boolean
  summary?: string
  patch?: PatchResult
  proposedContent?: string
  currentContent?: string
}

export interface ApplyKeyBindingsOptions {
  dryRun?: boolean
}

/**
 * Read master, parse user-config keybindings, merge, write with sentinel.
 * First clean apply captures the user's original baseline as `.bak`.
 * Dry-run returns the proposed content for diffing without touching disk.
 */
export async function applyKeyBindings(
  engineVersionShort: string,
  masterPath: string,
  opts: ApplyKeyBindingsOptions = {}
): Promise<ApplyKeyBindingsResult> {
  let masterContent: string
  try {
    masterContent = await fsp.readFile(masterPath, 'utf-8')
  } catch (err) {
    return {
      ok: false,
      error: `Could not read master at ${masterPath}: ${
        err instanceof Error ? err.message : String(err)
      }`
    }
  }
  const iniPath = getKeyBindingsIniPath(engineVersionShort)
  let userContent = ''
  try {
    userContent = await fsp.readFile(iniPath, 'utf-8')
  } catch {
    /* no user file yet → treat as empty */
  }

  const backupPath = getKeyBindingsBackupPath(engineVersionShort)
  const hadSentinel = hasSentinel(userContent)
  let backupExists = false
  try {
    await fsp.access(backupPath)
    backupExists = true
  } catch {
    /* none */
  }

  const cleanContent = hadSentinel ? stripSentinelHeader(userContent) : userContent
  const userDoc = parseIni(cleanContent)
  const masterDoc = parseIni(masterContent)
  const patch = applyMerge(userDoc, masterDoc)
  const merged = serializeIni(userDoc)
  const masterHash = computeMasterHash(masterContent)
  const finalContent = buildSentinelLine(masterHash) + '\r\n\r\n' + merged

  if (opts.dryRun) {
    return {
      ok: true,
      iniPath,
      backupPath,
      backupWritten: !hadSentinel && !backupExists && userContent.length > 0,
      summary: summarisePatchResult(patch),
      patch,
      proposedContent: finalContent,
      currentContent: cleanContent
    }
  }

  await fsp.mkdir(path.dirname(iniPath), { recursive: true })

  let backupWritten = false
  if (!hadSentinel && !backupExists && userContent.length > 0) {
    await fsp.writeFile(backupPath, userContent, 'utf-8')
    backupWritten = true
  }

  const tmp = iniPath + '.tmp'
  await fsp.writeFile(tmp, finalContent, 'utf-8')
  await fsp.rename(tmp, iniPath)

  return {
    ok: true,
    iniPath,
    backupPath,
    backupWritten,
    summary: summarisePatchResult(patch),
    patch
  }
}

export interface RestoreKeyBindingsResult {
  ok: boolean
  error?: string
  iniPath?: string
}

export async function restoreKeyBindings(
  engineVersionShort: string
): Promise<RestoreKeyBindingsResult> {
  const iniPath = getKeyBindingsIniPath(engineVersionShort)
  const backupPath = getKeyBindingsBackupPath(engineVersionShort)
  try {
    await fsp.access(backupPath)
  } catch {
    return {
      ok: false,
      error:
        `No baseline backup at ${backupPath}. The .bak is created automatically on the first ` +
        `Apply against an un-patched keybindings file — delete or clear yours, then Apply once ` +
        `to capture a fresh baseline.`
    }
  }
  await fsp.mkdir(path.dirname(iniPath), { recursive: true })
  const tmp = iniPath + '.tmp'
  await fsp.copyFile(backupPath, tmp)
  await fsp.rename(tmp, iniPath)
  return { ok: true, iniPath }
}
