import { app } from 'electron'
import { promises as fsp } from 'node:fs'
import * as path from 'node:path'

/**
 * Built-in plugin preset library: read-only templates shipped in
 * `resources/presets/plugins/`. The chooser lists these alongside an "Empty"
 * fallback; selecting one copies its `{ plugins: [...] }` payload into
 * `userData/ReHoarderPluginConfig.json` (the same path the zero-config
 * bootstrap plants) so existing flows continue to work unchanged.
 *
 * Built-in files may carry `label` + `description` metadata on top of the
 * canonical PluginPreset shape — the metadata is stripped when copying so
 * the on-disk preset stays drop-in compatible with the existing reader.
 * Two provenance fields (`_source`, `_applied`) are written into the user
 * file at apply time so future flows can offer "reapply latest" / drift
 * detection. The reader ignores unknown fields, so they're safe to embed.
 */

export interface BuiltInPresetMeta {
  /** Stable id used by IPC; derived from the filename without `.json`. */
  id: string
  label: string
  description: string | null
  pluginCount: number
}

interface BuiltInPresetFile {
  label?: unknown
  description?: unknown
  plugins?: unknown
}

/** The canonical destination — matches the bootstrap path in engines-ipc.ts. */
export function defaultPresetTargetPath(): string {
  return path.join(app.getPath('userData'), 'ReHoarderPluginConfig.json')
}

/** Resolve the built-in presets directory; dev vs packaged differ. */
function builtInDir(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'presets', 'plugins')
  }
  return path.join(app.getAppPath(), 'resources', 'presets', 'plugins')
}

export async function listBuiltInPlugins(): Promise<BuiltInPresetMeta[]> {
  const dir = builtInDir()
  let entries: string[]
  try {
    entries = await fsp.readdir(dir)
  } catch {
    return []
  }
  const out: BuiltInPresetMeta[] = []
  for (const name of entries) {
    if (!name.toLowerCase().endsWith('.json')) continue
    const abs = path.join(dir, name)
    try {
      const raw = await fsp.readFile(abs, 'utf-8')
      const parsed = JSON.parse(raw) as BuiltInPresetFile
      const plugins = Array.isArray(parsed.plugins) ? parsed.plugins : []
      const id = name.replace(/\.json$/i, '')
      out.push({
        id,
        label: typeof parsed.label === 'string' && parsed.label.trim().length > 0 ? parsed.label : id,
        description: typeof parsed.description === 'string' ? parsed.description : null,
        pluginCount: plugins.length
      })
    } catch {
      /* skip unreadable / malformed file */
    }
  }
  // "example" / "empty" starter templates pinned first; rest alphabetical by label.
  out.sort((a, b) => {
    const aPinned = a.id === 'example' || a.id === 'empty'
    const bPinned = b.id === 'example' || b.id === 'empty'
    if (aPinned && !bPinned) return -1
    if (!aPinned && bPinned) return 1
    return a.label.localeCompare(b.label)
  })
  return out
}

export interface UseBuiltInPluginResult {
  ok: boolean
  error?: string
  /** Absolute path of the preset file that was written and is now active. */
  path?: string
}

/**
 * Copy the built-in preset identified by `id` into the default user preset
 * file, stripping metadata so the on-disk payload stays minimal. Caller is
 * responsible for setting the global path setting afterwards.
 */
export async function useBuiltInPlugin(id: string): Promise<UseBuiltInPluginResult> {
  if (!/^[A-Za-z0-9._-]+$/.test(id)) {
    return { ok: false, error: 'Invalid preset id' }
  }
  const src = path.join(builtInDir(), `${id}.json`)
  let raw: string
  try {
    raw = await fsp.readFile(src, 'utf-8')
  } catch (err) {
    return {
      ok: false,
      error: `Could not read built-in preset: ${err instanceof Error ? err.message : String(err)}`
    }
  }
  let parsed: BuiltInPresetFile
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    return {
      ok: false,
      error: `Built-in preset is not valid JSON: ${err instanceof Error ? err.message : String(err)}`
    }
  }
  const templatePlugins = Array.isArray(parsed.plugins) ? parsed.plugins : []
  const target = defaultPresetTargetPath()

  // Preserve entries the user explicitly added/modified via "Add to config"
  // (marked with `fromUser: true`). They survive re-apply verbatim; the rest
  // of the file is replaced with the fresh template state.
  const userKeepers = await readUserFlaggedEntries(target)
  const keeperNames = new Set(userKeepers.map((e) => entryNameLower(e)))
  const templateRest = templatePlugins.filter((p) => {
    const name = entryNameLower(p)
    return name.length > 0 && !keeperNames.has(name)
  })
  const mergedPlugins = [...userKeepers, ...templateRest]

  try {
    await fsp.mkdir(path.dirname(target), { recursive: true })
    const tmp = target + '.tmp'
    const payload = {
      _source: id,
      _applied: new Date().toISOString(),
      plugins: mergedPlugins
    }
    await fsp.writeFile(tmp, JSON.stringify(payload, null, 2) + '\n', 'utf-8')
    await fsp.rename(tmp, target)
  } catch (err) {
    return {
      ok: false,
      error: `Could not write preset: ${err instanceof Error ? err.message : String(err)}`
    }
  }
  return { ok: true, path: target }
}

/**
 * Read entries from the current user preset that carry `fromUser: true`.
 * Tolerates missing / unparseable file (returns empty). Used by re-apply to
 * preserve user-overridden entries.
 */
async function readUserFlaggedEntries(targetPath: string): Promise<unknown[]> {
  try {
    const raw = await fsp.readFile(targetPath, 'utf-8')
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object') return []
    const plugins = (parsed as { plugins?: unknown }).plugins
    if (!Array.isArray(plugins)) return []
    return plugins.filter(
      (p) =>
        p !== null &&
        typeof p === 'object' &&
        (p as Record<string, unknown>).fromUser === true
    )
  } catch {
    return []
  }
}

/** Lowercase name for case-insensitive de-duplication. Empty string on garbage. */
function entryNameLower(entry: unknown): string {
  if (!entry || typeof entry !== 'object') return ''
  const name = (entry as Record<string, unknown>).name
  return typeof name === 'string' ? name.toLowerCase() : ''
}
