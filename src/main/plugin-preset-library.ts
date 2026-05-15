import { app } from 'electron'
import { promises as fsp } from 'node:fs'
import * as path from 'node:path'

/**
 * Built-in plugin preset library: read-only templates shipped in
 * `resources/presets/plugins/`. The chooser lists these alongside an "Empty"
 * fallback; selecting one copies its `{ plugins: [...] }` payload into
 * `userData/plugin-preset.json` (the same path the zero-config bootstrap
 * already plants) so existing flows continue to work unchanged.
 *
 * Built-in files may carry `label` + `description` metadata on top of the
 * canonical PluginPreset shape — the metadata is stripped when copying so
 * the on-disk preset stays drop-in compatible with the existing reader.
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
  return path.join(app.getPath('userData'), 'plugin-preset.json')
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
  // Empty first when present, otherwise alphabetical by label.
  out.sort((a, b) => {
    if (a.id === 'empty') return -1
    if (b.id === 'empty') return 1
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
  const plugins = Array.isArray(parsed.plugins) ? parsed.plugins : []
  const target = defaultPresetTargetPath()
  try {
    await fsp.mkdir(path.dirname(target), { recursive: true })
    const tmp = target + '.tmp'
    await fsp.writeFile(tmp, JSON.stringify({ plugins }, null, 2) + '\n', 'utf-8')
    await fsp.rename(tmp, target)
  } catch (err) {
    return {
      ok: false,
      error: `Could not write preset: ${err instanceof Error ? err.message : String(err)}`
    }
  }
  return { ok: true, path: target }
}
