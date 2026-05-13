import { promises as fsp } from 'node:fs'
import * as path from 'node:path'

export interface DescriptorReadResult {
  /** The parsed `.uproject` JSON, exactly as it lives on disk. */
  json: unknown
  /** Last-modified ms (proxy for conflict detection — the renderer can re-check before writing). */
  mtime: number
}

export interface DescriptorWriteResult {
  json: unknown
  mtime: number
  /** Absolute path of the `.uproject.bak` file that was created before the write. */
  backupPath: string
}

/**
 * Load the JSON contents of an `.uproject` descriptor. We deliberately keep
 * the shape untyped (`unknown`) — Unreal projects ship a mixed bag of fields
 * (custom build settings, plugin-specific keys, …) and we want to round-trip
 * everything we don't actively edit instead of stripping unknown keys.
 */
export async function readDescriptor(uprojectPath: string): Promise<DescriptorReadResult> {
  const raw = await fsp.readFile(uprojectPath, 'utf-8')
  const json = JSON.parse(raw) as unknown
  const stat = await fsp.stat(uprojectPath)
  return { json, mtime: stat.mtimeMs }
}

/**
 * Replace the `.uproject` with the supplied JSON content. The previous file
 * is copied to `<name>.uproject.bak` first (best-effort: a failed copy does
 * not abort the write — losing the backup is preferable to losing the edit
 * the user already confirmed). The new content is written to a `.tmp` file
 * and then renamed over the target, so a crash during write can't leave a
 * partially-written `.uproject` for Unreal to choke on.
 *
 * Indentation uses tab characters with a trailing newline to match the style
 * Unreal Editor produces.
 */
export async function writeDescriptor(
  uprojectPath: string,
  content: unknown
): Promise<DescriptorWriteResult> {
  const dir = path.dirname(uprojectPath)
  const base = path.basename(uprojectPath)
  const backupPath = path.join(dir, base + '.bak')
  const tmpPath = path.join(dir, base + '.tmp')

  try {
    await fsp.copyFile(uprojectPath, backupPath)
  } catch (err) {
    console.warn(`[projects] descriptor backup skipped (${backupPath}):`, err)
  }

  const serialised = JSON.stringify(content, null, '\t') + '\n'
  await fsp.writeFile(tmpPath, serialised, 'utf-8')
  await fsp.rename(tmpPath, uprojectPath)

  const stat = await fsp.stat(uprojectPath)
  return { json: content, mtime: stat.mtimeMs, backupPath }
}

export interface EnginePluginInfo {
  /** Plugin name (= the `.uplugin` filename without the extension). */
  name: string
  /** Absolute path to the `.uplugin` file. */
  upluginPath: string
  /** First-segment classifier under `<engine>/Engine/Plugins/` (e.g. `Marketplace`, `Runtime`, `Editor`). */
  bucket: string
}

/**
 * Enumerate the `.uplugin` files under `<engineRootPath>/Engine/Plugins/`.
 *
 * Engine plugin layout in modern UE5 is:
 *   Engine/Plugins/{Marketplace,Runtime,Editor,…}/<PluginName>/<PluginName>.uplugin
 *
 * We walk one level for the bucket (Marketplace / Runtime / …) and one more
 * level for the plugin folder. We don't recurse deeper because a plugin's
 * own `.uplugin` lives at the top of its folder; descending further is just
 * `Source/` and `Content/` noise.
 */
export async function listEnginePlugins(engineRootPath: string): Promise<EnginePluginInfo[]> {
  const pluginsRoot = path.join(engineRootPath, 'Engine', 'Plugins')
  let buckets: string[]
  try {
    buckets = await fsp.readdir(pluginsRoot)
  } catch {
    return []
  }
  const results: EnginePluginInfo[] = []
  for (const bucket of buckets) {
    const bucketPath = path.join(pluginsRoot, bucket)
    let bucketStat
    try {
      bucketStat = await fsp.stat(bucketPath)
    } catch {
      continue
    }
    if (!bucketStat.isDirectory()) continue
    const plugin = await findUpluginAt(bucketPath, bucket, results)
    if (!plugin) {
      // Not a flat plugin folder — descend one more level into the bucket.
      let pluginDirs: string[]
      try {
        pluginDirs = await fsp.readdir(bucketPath)
      } catch {
        continue
      }
      for (const pluginName of pluginDirs) {
        await findUpluginAt(path.join(bucketPath, pluginName), bucket, results)
      }
    }
  }
  results.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
  return results
}

/**
 * If `dir` contains a `.uplugin`, push it into `out` and return `true`.
 * Used to short-circuit the walk when a bucket itself is a plugin folder.
 */
async function findUpluginAt(
  dir: string,
  bucket: string,
  out: EnginePluginInfo[]
): Promise<boolean> {
  let entries: string[]
  try {
    entries = await fsp.readdir(dir)
  } catch {
    return false
  }
  for (const name of entries) {
    if (name.toLowerCase().endsWith('.uplugin')) {
      const upluginPath = path.join(dir, name)
      out.push({
        name: name.replace(/\.uplugin$/i, ''),
        upluginPath,
        bucket
      })
      return true
    }
  }
  return false
}
