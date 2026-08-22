import { promises as fsp } from 'node:fs'
import * as path from 'node:path'
import type { LocalVaultKind } from './vault-local'
import { findEngineVersionInContent } from './uasset-version'

/** Loosely matches a `major.minor` engine version string like "5.4" or "4.27". */
const VERSION_LIKE = /^\d+\.\d+$/

/**
 * Infer the engine version for a vault asset that has no DB row and no
 * (valid) sidecar — a true "orphan". Used as tier 3 of `vault:list`'s
 * metadata resolution, after the sidecar and DB-join tiers have both missed.
 *
 * For a `project`, reads `EngineAssociation` out of the `.uproject` file
 * (a precise, cheap signal — no need to scan `.uasset` headers). Falls
 * through to the content scan when the project has no `.uproject` at the
 * expected location or its `EngineAssociation` isn't a real version (e.g. a
 * GUID pointing at a custom engine build).
 *
 * For an `asset` (or as the project fallback), scans `.uasset`/`.umap`
 * headers under the payload directory via `findEngineVersionInContent`.
 *
 * Never throws — any failure (missing dir, unreadable file, malformed JSON)
 * yields `null`, same as "couldn't determine it".
 */
export async function resolveVaultEngineVersion(
  assetDir: string,
  kind: string
): Promise<string | null> {
  try {
    const payloadDir = await resolvePayloadDir(assetDir)

    if (kind === ('project' satisfies LocalVaultKind)) {
      const fromProject = await resolveFromUproject(payloadDir)
      if (fromProject) return fromProject
    }

    return await findEngineVersionInContent(payloadDir)
  } catch {
    return null
  }
}

/** `<assetDir>/data` when it exists and is a directory, else `<assetDir>` itself. */
async function resolvePayloadDir(assetDir: string): Promise<string> {
  const dataDir = path.join(assetDir, 'data')
  try {
    const st = await fsp.stat(dataDir)
    if (st.isDirectory()) return dataDir
  } catch {
    // fall through
  }
  return assetDir
}

/**
 * Find the first `*.uproject` among the immediate children of `payloadDir`
 * and return its `EngineAssociation` when it looks like a real
 * `major.minor` version. Returns `null` on any miss (no file, unparsable
 * JSON, missing/GUID/empty `EngineAssociation`).
 */
async function resolveFromUproject(payloadDir: string): Promise<string | null> {
  let entries: import('node:fs').Dirent[]
  try {
    entries = await fsp.readdir(payloadDir, { withFileTypes: true })
  } catch {
    return null
  }
  const uprojectName = entries.find(
    (e) => e.isFile() && e.name.toLowerCase().endsWith('.uproject')
  )?.name
  if (!uprojectName) return null

  try {
    const raw = await fsp.readFile(path.join(payloadDir, uprojectName), 'utf-8')
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const assoc = parsed.EngineAssociation
    if (typeof assoc === 'string' && VERSION_LIKE.test(assoc)) return assoc
    return null
  } catch {
    return null
  }
}
