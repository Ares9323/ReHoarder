import { promises as fsp } from 'node:fs'
import * as path from 'node:path'
import { toRhFileUrl } from './projects-local'

/**
 * Rich metadata extracted from a single `.uplugin` file. The two boolean
 * fields the toggler cares about (`enabledByDefault`, `installed`) are the
 * only ones the writer rewrites; everything else is informational for the UI.
 */
export interface EnginePluginRich {
  /** Plugin name = filename without `.uplugin`. Stable identifier. */
  name: string
  /** Human-readable name from the `.uplugin` (`FriendlyName` key), falling back to `name`. */
  friendlyName: string
  description: string
  category: string
  versionName: string
  /** Absolute path to the `.uplugin` file. */
  upluginPath: string
  /** Path relative to the engine root, with forward slashes — for display only. */
  relativePath: string
  /** First-segment classifier under `<engine>/Engine/Plugins/` (Marketplace, Runtime, Editor, …). */
  bucket: string
  /** `rh-file://` URL for the plugin's icon when `Resources/Icon128.png` exists; null otherwise. */
  iconUrl: string | null
  /** Effective value of `"EnabledByDefault"` in the .uplugin (missing = `false`). */
  enabledByDefault: boolean
  /** Effective value of `"Installed"` in the .uplugin (missing = `false`). */
  installed: boolean
}

/**
 * Folder names to skip during the recursive plugin walk — they're either
 * known noise (build artefacts, content, generated source) or just expensive
 * to descend into for no benefit. Matching is case-insensitive.
 *
 * Mirrors the list used by UnrealPluginToggler — same set of trees never
 * contains a `.uplugin` worth looking at.
 */
const SKIPPED_FOLDERS = new Set([
  'binaries',
  'config',
  'content',
  'docs',
  'intermediate',
  'saved',
  'source',
  'resources',
  'shaders',
  'deriveddatacache'
])

/**
 * Strip JSON5-isms from a `.uplugin` so the strict `JSON.parse` accepts it:
 *   - `//` line comments to end of line
 *   - `/* ... *\/` block comments (including multi-line)
 *   - trailing commas before `}` / `]`
 *
 * String-literal awareness keeps comment-like sequences inside quoted strings
 * untouched (descriptions can contain `//` or `/*` legitimately).
 */
function relaxJsonForParse(src: string): string {
  let out = ''
  let i = 0
  const len = src.length
  while (i < len) {
    const c = src[i]
    // String literal — copy verbatim including escaped chars.
    if (c === '"') {
      const start = i
      i++
      while (i < len) {
        const ch = src[i]
        if (ch === '\\' && i + 1 < len) {
          i += 2
          continue
        }
        if (ch === '"') {
          i++
          break
        }
        i++
      }
      out += src.slice(start, i)
      continue
    }
    // Line comment.
    if (c === '/' && src[i + 1] === '/') {
      i += 2
      while (i < len && src[i] !== '\n') i++
      continue
    }
    // Block comment.
    if (c === '/' && src[i + 1] === '*') {
      i += 2
      while (i < len && !(src[i] === '*' && src[i + 1] === '/')) i++
      i += 2
      continue
    }
    out += c
    i++
  }
  // Trailing commas. Walk again outside strings.
  return stripTrailingCommas(out)
}

function stripTrailingCommas(src: string): string {
  let out = ''
  let i = 0
  const len = src.length
  while (i < len) {
    const c = src[i]
    if (c === '"') {
      // copy string literal whole
      const start = i
      i++
      while (i < len) {
        const ch = src[i]
        if (ch === '\\' && i + 1 < len) {
          i += 2
          continue
        }
        if (ch === '"') {
          i++
          break
        }
        i++
      }
      out += src.slice(start, i)
      continue
    }
    if (c === ',') {
      // Look ahead past whitespace for the next non-space character.
      let j = i + 1
      while (j < len && /\s/.test(src[j])) j++
      if (j < len && (src[j] === '}' || src[j] === ']')) {
        // skip the comma
        i = j
        continue
      }
    }
    out += c
    i++
  }
  return out
}

interface RawUpluginShape {
  FriendlyName?: string
  Description?: string
  Category?: string
  VersionName?: string
  EnabledByDefault?: boolean
  Installed?: boolean
  [key: string]: unknown
}

/**
 * Walk `<engine>/Engine/Plugins/` and return one entry per `.uplugin` file.
 * The walk recurses into subdirectories that aren't on `SKIPPED_FOLDERS`;
 * a plugin folder typically holds its `.uplugin` at the top level alongside
 * `Resources/` and `Source/`, but third-party packs sometimes nest deeper,
 * so we don't try to be too clever about depth.
 */
export async function listEnginePluginsRich(engineRoot: string): Promise<EnginePluginRich[]> {
  const pluginsRoot = path.join(engineRoot, 'Engine', 'Plugins')
  try {
    const s = await fsp.stat(pluginsRoot)
    if (!s.isDirectory()) return []
  } catch {
    return []
  }
  const found: string[] = []
  await walkForUplugin(pluginsRoot, found)
  const out: EnginePluginRich[] = []
  for (const upluginPath of found) {
    const entry = await readUplugin(upluginPath, engineRoot, pluginsRoot)
    if (entry) out.push(entry)
  }
  // EnabledByDefault DESC, FriendlyName ASC, Category ASC — same convention
  // as the source tool. Helps the UI surface the "active" plugins first.
  out.sort((a, b) => {
    const ed = (b.enabledByDefault ? 1 : 0) - (a.enabledByDefault ? 1 : 0)
    if (ed !== 0) return ed
    const fn = a.friendlyName.localeCompare(b.friendlyName, undefined, { sensitivity: 'base' })
    if (fn !== 0) return fn
    return a.category.localeCompare(b.category, undefined, { sensitivity: 'base' })
  })
  return out
}

async function walkForUplugin(dir: string, found: string[]): Promise<void> {
  let entries: import('node:fs').Dirent[]
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (SKIPPED_FOLDERS.has(e.name.toLowerCase())) continue
      await walkForUplugin(path.join(dir, e.name), found)
      continue
    }
    if (e.isFile() && e.name.toLowerCase().endsWith('.uplugin')) {
      found.push(path.join(dir, e.name))
    }
  }
}

async function readUplugin(
  upluginPath: string,
  engineRoot: string,
  pluginsRoot: string
): Promise<EnginePluginRich | null> {
  let json: RawUpluginShape
  try {
    const raw = await fsp.readFile(upluginPath, 'utf-8')
    json = JSON.parse(relaxJsonForParse(raw)) as RawUpluginShape
  } catch {
    return null
  }
  const name = path.basename(upluginPath).replace(/\.uplugin$/i, '')
  const friendlyName = typeof json.FriendlyName === 'string' && json.FriendlyName.length > 0
    ? json.FriendlyName
    : name
  const description = typeof json.Description === 'string' ? json.Description : ''
  const category = typeof json.Category === 'string' ? json.Category : ''
  const versionName = typeof json.VersionName === 'string' ? json.VersionName : ''
  const enabledByDefault = typeof json.EnabledByDefault === 'boolean' ? json.EnabledByDefault : false
  const installed = typeof json.Installed === 'boolean' ? json.Installed : false

  // Bucket = first segment under <engine>/Engine/Plugins/. Useful for the UI
  // (e.g. "Marketplace" vs "Runtime") and falls back to an empty string when
  // the .uplugin sits directly in Engine/Plugins/.
  const relFromPlugins = path.relative(pluginsRoot, upluginPath).replace(/\\/g, '/')
  const firstSep = relFromPlugins.indexOf('/')
  const bucket = firstSep > 0 ? relFromPlugins.slice(0, firstSep) : ''

  const relFromEngine = path.relative(engineRoot, upluginPath).replace(/\\/g, '/')

  // Icon discovery: <pluginDir>/Resources/Icon128.png (or icon128.png — some
  // older marketplace plugins ship the lowercase variant). We use rh-file://
  // so the renderer's CSP stays tight; the protocol allow-list already covers
  // engine paths.
  const pluginDir = path.dirname(upluginPath)
  let iconUrl: string | null = null
  for (const candidate of ['Icon128.png', 'icon128.png']) {
    const iconPath = path.join(pluginDir, 'Resources', candidate)
    try {
      await fsp.access(iconPath)
      iconUrl = toRhFileUrl(iconPath)
      break
    } catch {
      /* try next */
    }
  }

  return {
    name,
    friendlyName,
    description,
    category,
    versionName,
    upluginPath,
    relativePath: relFromEngine,
    bucket,
    iconUrl,
    enabledByDefault,
    installed
  }
}

export interface SetPluginStateRequest {
  upluginPath: string
  enabledByDefault?: boolean
  installed?: boolean
}

export interface SetPluginStateResult {
  ok: boolean
  error?: string
  /** Snapshot of the values that ended up on disk after the write. */
  enabledByDefault?: boolean
  installed?: boolean
}

/**
 * Edit a `.uplugin` to set `EnabledByDefault` and/or `Installed`. The write is
 * regex-based on the raw file text (NOT a JSON.parse/stringify round-trip) so
 * the original formatting, comments and key order are preserved.
 *
 * Robustness:
 *   - Read-only attribute is cleared before the write (Marketplace plugins
 *     sometimes ship with the bit set).
 *   - A `.bak` is written before the new content; on failure the file is
 *     restored from `.bak`. On success the `.bak` is removed.
 *   - When a field is missing, it's injected immediately above `"Modules"`
 *     with the same indentation, matching the convention shipped templates use.
 */
export async function setEnginePluginState(
  req: SetPluginStateRequest
): Promise<SetPluginStateResult> {
  if (req.enabledByDefault === undefined && req.installed === undefined) {
    return { ok: false, error: 'No changes specified' }
  }
  let original: string
  try {
    original = await fsp.readFile(req.upluginPath, 'utf-8')
  } catch (err) {
    return { ok: false, error: `Could not read ${req.upluginPath}: ${errMsg(err)}` }
  }

  // Clear read-only so the write doesn't fail with EACCES on packaged engines.
  try {
    const st = await fsp.stat(req.upluginPath)
    // 0o200 = owner-write. If missing on the mode, restore it.
    if ((st.mode & 0o200) === 0) {
      await fsp.chmod(req.upluginPath, st.mode | 0o200)
    }
  } catch {
    /* ignore — chmod failure surfaces later in the write */
  }

  let next = original
  if (req.enabledByDefault !== undefined) {
    next = upsertBoolField(next, 'EnabledByDefault', req.enabledByDefault)
  }
  if (req.installed !== undefined) {
    next = upsertBoolField(next, 'Installed', req.installed)
  }

  const backupPath = req.upluginPath + '.bak'
  try {
    await fsp.copyFile(req.upluginPath, backupPath)
  } catch (err) {
    return { ok: false, error: `Could not create backup: ${errMsg(err)}` }
  }
  try {
    await fsp.writeFile(req.upluginPath, next, 'utf-8')
    await fsp.unlink(backupPath).catch(() => {})
  } catch (err) {
    // Restore from backup before surfacing the error.
    try {
      await fsp.copyFile(backupPath, req.upluginPath)
      await fsp.unlink(backupPath).catch(() => {})
    } catch {
      /* swallow — we'll surface the original write error */
    }
    return { ok: false, error: `Write failed: ${errMsg(err)}` }
  }

  return {
    ok: true,
    enabledByDefault:
      req.enabledByDefault !== undefined
        ? req.enabledByDefault
        : extractBool(next, 'EnabledByDefault'),
    installed:
      req.installed !== undefined ? req.installed : extractBool(next, 'Installed')
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * Replace `"<key>": true|false` if present, else insert the field as a new
 * line above `"Modules"` (matching its indentation). Case-insensitive on the
 * key match so quirky casings survive.
 */
function upsertBoolField(content: string, key: string, value: boolean): string {
  const re = new RegExp(`("${escapeRegExp(key)}"\\s*:\\s*)(true|false)`, 'i')
  if (re.test(content)) {
    return content.replace(re, `$1${value ? 'true' : 'false'}`)
  }
  // Field missing — insert before the `"Modules"` array. The indentation of
  // the Modules line determines our insertion indent, so the inserted field
  // matches the surrounding block visually.
  const modulesRe = /^(\s*)("Modules"\s*:)/m
  const m = modulesRe.exec(content)
  if (m) {
    const indent = m[1]
    const insertion = `${indent}"${key}": ${value ? 'true' : 'false'},\n`
    return content.slice(0, m.index) + insertion + content.slice(m.index)
  }
  // No `"Modules"` either — fall back to inserting near the top, just after
  // the opening `{`. Rare for a real .uplugin but better than no-op.
  const openBrace = content.indexOf('{')
  if (openBrace >= 0) {
    return (
      content.slice(0, openBrace + 1) +
      `\n\t"${key}": ${value ? 'true' : 'false'},` +
      content.slice(openBrace + 1)
    )
  }
  return content
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function extractBool(content: string, key: string): boolean {
  const re = new RegExp(`"${escapeRegExp(key)}"\\s*:\\s*(true|false)`, 'i')
  const m = re.exec(content)
  return m ? m[1].toLowerCase() === 'true' : false
}

export interface UninstallPluginResult {
  ok: boolean
  error?: string
  /** Absolute path of the directory that was removed (or attempted to). */
  pluginDir?: string
}

/**
 * Permanently delete a plugin's folder from disk. Only allowed for plugins
 * shipped under `Engine/Plugins/Marketplace/` — engine-default plugins
 * (Runtime, Editor, etc.) are part of the install image and removing them
 * would corrupt the engine.
 *
 * Safety:
 *   - Refuses any path that isn't a `.uplugin`
 *   - Refuses unless the plugin folder lives under
 *     `<engine>/Engine/Plugins/Marketplace/<PluginFolder>/`
 *   - Refuses when the resolved directory would be the Marketplace folder
 *     itself or any of its ancestors
 */
export async function uninstallEnginePlugin(upluginPath: string): Promise<UninstallPluginResult> {
  if (!upluginPath.toLowerCase().endsWith('.uplugin')) {
    return { ok: false, error: 'Target file is not a .uplugin' }
  }
  const pluginDir = path.dirname(path.resolve(upluginPath))
  const norm = pluginDir.replace(/\\/g, '/').toLowerCase()
  // Must contain `/engine/plugins/marketplace/<something>/` — the trailing
  // segment is the plugin folder itself, so the marketplace token must NOT
  // be the last segment (that'd be the Marketplace dir itself).
  const m = /\/engine\/plugins\/marketplace\/([^/]+)\/?$/.exec(norm)
  if (!m) {
    return {
      ok: false,
      error: 'Only Marketplace plugins can be uninstalled from here.'
    }
  }
  try {
    await fsp.rm(pluginDir, { recursive: true, force: true })
  } catch (err) {
    return {
      ok: false,
      error: `Could not remove plugin directory: ${errMsg(err)}`
    }
  }
  return { ok: true, pluginDir }
}
