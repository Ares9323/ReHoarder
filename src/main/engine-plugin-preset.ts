import { promises as fsp } from 'node:fs'
import * as path from 'node:path'
import type { AppSettings } from './settings'

/**
 * Single entry in a plugin preset JSON. The desired final state for one
 * `.uplugin`, keyed by plugin name (= filename without `.uplugin`). The shape
 * matches the existing JSON the user already maintains in their
 * UnrealPluginToggler workflow — drop-in compatible.
 */
export interface PluginPresetEntry {
  name: string
  enabledByDefault: boolean
  installed: boolean
}

export interface PluginPreset {
  /** Schema version. Bump only on a breaking change. */
  version?: number
  plugins: PluginPresetEntry[]
}

export interface ResolvedPreset {
  /** Absolute path of the file that ended up active for the engine. */
  path: string
  /** Whether the file came from the per-engine override or the global fallback. */
  source: 'per-engine' | 'global'
  entries: PluginPresetEntry[]
}

/**
 * Pick which preset file applies to `engineRoot` and parse it. Per-engine
 * overrides win over the global fallback; both can be unset, in which case
 * we return `null` (the UI surfaces "no preset configured").
 *
 * Returns `{ ok: false, error }` when a configured path exists but can't be
 * read or doesn't parse — silently falling back to global on a malformed
 * per-engine override would hide a real misconfiguration from the user.
 */
export async function resolvePresetForEngine(
  engineRoot: string,
  settings: AppSettings
): Promise<ResolvedPreset | null | { ok: false; error: string }> {
  const resolvedEngine = path.resolve(engineRoot)
  const perEnginePath = pickPerEnginePath(resolvedEngine, settings.pluginPresetPerEngine)
  const candidatePath = perEnginePath ?? (settings.pluginPresetGlobalPath || null)
  if (!candidatePath) return null
  const source: 'per-engine' | 'global' = perEnginePath ? 'per-engine' : 'global'
  try {
    const entries = await readPresetFile(candidatePath)
    return { path: candidatePath, source, entries }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * Match a per-engine override key against `engineRoot`. Comparison is
 * case-insensitive on Windows and exact-equality + prefix-tolerant elsewhere,
 * so a user that stored the path slightly differently still gets the override.
 */
function pickPerEnginePath(
  engineRoot: string,
  overrides: Record<string, string>
): string | null {
  const caseFold = process.platform === 'win32'
  const norm = (s: string): string => path.resolve(s).replace(/[\\/]+$/, '')
  const target = caseFold ? norm(engineRoot).toLowerCase() : norm(engineRoot)
  for (const [k, v] of Object.entries(overrides)) {
    if (!v) continue
    const candidate = caseFold ? norm(k).toLowerCase() : norm(k)
    if (candidate === target) return v
  }
  return null
}

/**
 * Read + validate a preset JSON. Accepts the existing `{ plugins: [...] }`
 * shape; entries with missing/wrong types are dropped silently so a small
 * typo in one row doesn't reject the whole file.
 */
export async function readPresetFile(absolutePath: string): Promise<PluginPresetEntry[]> {
  const raw = await fsp.readFile(absolutePath, 'utf-8')
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    throw new Error(
      `Preset file is not valid JSON (${absolutePath}): ${
        err instanceof Error ? err.message : String(err)
      }`
    )
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`Preset file root must be an object: ${absolutePath}`)
  }
  const plugins = (parsed as { plugins?: unknown }).plugins
  if (!Array.isArray(plugins)) {
    throw new Error(`Preset file has no "plugins" array: ${absolutePath}`)
  }
  const out: PluginPresetEntry[] = []
  for (const item of plugins) {
    if (!item || typeof item !== 'object') continue
    const rec = item as Record<string, unknown>
    const name = rec.name
    const enabledByDefault = rec.enabledByDefault
    const installed = rec.installed
    if (typeof name !== 'string' || name.length === 0) continue
    if (typeof enabledByDefault !== 'boolean' || typeof installed !== 'boolean') continue
    out.push({ name, enabledByDefault, installed })
  }
  return out
}
