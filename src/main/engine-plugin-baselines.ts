import * as crypto from 'node:crypto'
import { promises as fsp } from 'node:fs'
import * as path from 'node:path'
import { app } from 'electron'

/**
 * One per-engine baseline file is the "Day 0" snapshot of every .uplugin's
 * EnabledByDefault/Installed flags as they were when ReHoarder first touched
 * the engine. Subsequent writes never overwrite it — it stays as the rollback
 * target the user can always go back to.
 *
 * Filename = SHA1(engineRoot) so unrelated engines never collide on disk and
 * we don't have to think about Windows-illegal characters in the path. The
 * human-readable engine path is stored inside the JSON for transparency.
 */
export interface PluginBaselineEntry {
  name: string
  upluginPath: string
  enabledByDefault: boolean
  installed: boolean
}

export interface PluginBaseline {
  /** Schema version. Bump only on a breaking change. */
  version: 1
  /** Absolute engine root the snapshot was taken from. */
  engineRoot: string
  /** Epoch ms the baseline was captured at. */
  createdAt: number
  plugins: PluginBaselineEntry[]
}

export interface BaselineInfo {
  exists: boolean
  createdAt?: number
  pluginCount?: number
  path?: string
  /** Full plugin snapshot — only populated when `exists=true`. */
  plugins?: PluginBaselineEntry[]
}

const BASELINES_DIR = 'plugin-baselines'

function baselinesDir(): string {
  return path.join(app.getPath('userData'), BASELINES_DIR)
}

function hashForEngine(engineRoot: string): string {
  // Normalise case on Windows + collapse separators so the same engine path
  // typed two different ways still maps to the same hash.
  const normalised =
    process.platform === 'win32'
      ? path.resolve(engineRoot).toLowerCase()
      : path.resolve(engineRoot)
  return crypto.createHash('sha1').update(normalised).digest('hex')
}

function baselinePath(engineRoot: string): string {
  return path.join(baselinesDir(), `${hashForEngine(engineRoot)}.json`)
}

/**
 * Existence + summary check + the full plugin snapshot. The renderer needs
 * the snapshot to compute divergence (current on-disk state vs baseline)
 * so it can hide the Restore button when nothing would actually change.
 *
 * Cheap on the wire — a typical engine's baseline is ~300 small entries
 * (~30 KB), well below the IPC threshold we care about.
 */
export async function readBaselineInfo(engineRoot: string): Promise<BaselineInfo> {
  const p = baselinePath(engineRoot)
  try {
    const raw = await fsp.readFile(p, 'utf-8')
    const parsed = JSON.parse(raw) as PluginBaseline
    return {
      exists: true,
      createdAt: parsed.createdAt,
      pluginCount: parsed.plugins?.length ?? 0,
      path: p,
      plugins: parsed.plugins ?? []
    }
  } catch {
    return { exists: false }
  }
}

export async function readBaseline(engineRoot: string): Promise<PluginBaseline | null> {
  try {
    const raw = await fsp.readFile(baselinePath(engineRoot), 'utf-8')
    return JSON.parse(raw) as PluginBaseline
  } catch {
    return null
  }
}

/**
 * Create the baseline file if and only if one doesn't already exist. Subsequent
 * calls are silent no-ops — the original Day-0 snapshot is the single source
 * of truth and must NEVER be overwritten by later writes.
 *
 * Returns the path actually used so the caller can surface it in logs.
 */
export async function ensureBaseline(
  engineRoot: string,
  plugins: PluginBaselineEntry[]
): Promise<{ created: boolean; path: string }> {
  const p = baselinePath(engineRoot)
  try {
    await fsp.access(p)
    return { created: false, path: p }
  } catch {
    /* doesn't exist — create it */
  }
  await fsp.mkdir(baselinesDir(), { recursive: true })
  const payload: PluginBaseline = {
    version: 1,
    engineRoot: path.resolve(engineRoot),
    createdAt: Date.now(),
    plugins
  }
  // Atomic write — temp file + rename. Avoids leaving a half-written
  // baseline if the process crashes mid-write (which would defeat the whole
  // purpose of having a rollback target).
  const tmp = p + '.tmp'
  await fsp.writeFile(tmp, JSON.stringify(payload, null, 2) + '\n', 'utf-8')
  await fsp.rename(tmp, p)
  return { created: true, path: p }
}

/**
 * Remove a baseline. Provided as an escape hatch (e.g. "I trust my current
 * state, redo the snapshot from here") — not wired into the UI yet but kept
 * available for the future.
 */
export async function deleteBaseline(engineRoot: string): Promise<boolean> {
  try {
    await fsp.unlink(baselinePath(engineRoot))
    return true
  } catch {
    return false
  }
}

/**
 * Synthesise the baseline entry for a single plugin.
 *
 * Plugins shipped inside `Engine/Plugins/Marketplace/` are user-installed
 * marketplace content whose live state reflects marketplace/user activity,
 * not engine defaults. Capturing whatever transient state they happen to be
 * in at "Day 0" would pin the baseline to a moving target. Instead we record
 * a stable synthetic posture — `EnabledByDefault=false, Installed=true` —
 * which means "tracked as installed, not auto-enabled" and matches Epic's
 * out-of-the-box convention for marketplace content.
 *
 * All other plugins (Engine, Developer, Experimental, Runtime, MetaHuman,
 * Media, etc.) are recorded as-is so the baseline preserves Epic's per-
 * version defaults.
 */
export function toBaselineEntry(p: {
  name: string
  upluginPath: string
  enabledByDefault: boolean
  installed: boolean
}): PluginBaselineEntry {
  if (isMarketplacePath(p.upluginPath)) {
    return {
      name: p.name,
      upluginPath: p.upluginPath,
      enabledByDefault: false,
      installed: true
    }
  }
  return {
    name: p.name,
    upluginPath: p.upluginPath,
    enabledByDefault: p.enabledByDefault,
    installed: p.installed
  }
}

/**
 * Path is under `Engine/Plugins/Marketplace/` AND not on the IDE-managed
 * allow-list (e.g. RiderLink, which JetBrains Rider drops in there but
 * ReHoarder shouldn't treat as user-installed marketplace content).
 */
export function isMarketplacePath(upluginPath: string): boolean {
  const norm = upluginPath.replace(/\\/g, '/').toLowerCase()
  if (!norm.includes('/engine/plugins/marketplace/')) return false
  if (isIdeManagedPlugin(norm)) return false
  return true
}

/** Plugins that live in the Marketplace folder but are owned by an IDE,
 *  not by the user via Fab. They should follow normal engine-plugin rules. */
function isIdeManagedPlugin(normalisedPath: string): boolean {
  return normalisedPath.endsWith('/riderlink.uplugin')
}
