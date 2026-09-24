import { promises as fsp } from 'node:fs'
import * as path from 'node:path'
import type { LocalVaultKind } from './vault-local'
import type { AssetSource } from './db/assets-repo'

/** Filename of the per-asset metadata sidecar, written at the top level of a
 *  vault asset folder (next to `data/`, NOT inside it). */
export const SIDECAR_FILENAME = '.rehoarder.json'

/** Only sidecars stamped with a known `version` are honoured; anything else
 *  is treated as "no sidecar" so the reader can fall through to the DB join. */
const KNOWN_VERSION = 1

/** Discriminator stamped on every vault sidecar. `createProjectFromVault`
 *  (src/main/projects-create.ts) writes a *different* `.rehoarder.json`
 *  (a project marker) into a created project root, using the same filename
 *  and `version: 1` but WITHOUT this field — `readSidecar` uses it to reject
 *  that shape rather than misreading it as a vault sidecar. */
const SIDECAR_TYPE = 'vault-asset'

/**
 * Metadata persisted next to a vault asset so the vault list no longer
 * depends on a live `downloads` join. Version-stamped for future migrations.
 * Distinct from the project marker `createProjectFromVault` writes into a
 * created project (same filename, different location and consumer) — the
 * `type` discriminator below is what tells them apart.
 *
 * `source`/`sourceId` are nullable: orphan assets (no DB row, no Fab
 * identity — e.g. hand-copied into the vault, or inferred purely from
 * on-disk content by the tier-3 resolver) have no source to record.
 */
export interface VaultSidecar {
  version: 1
  type: 'vault-asset'
  source: AssetSource | null
  sourceId: string | null
  engineVersion: string | null
  /** Fab `Manifest.meta.buildVersion` of the downloaded payload. Null for orphans and pre-field sidecars. */
  buildVersion: string | null
  title: string | null
  kind: LocalVaultKind
  fabDistributionMethod: string | null
  downloadedAt: number
}

/**
 * Read and validate `<assetDir>/.rehoarder.json`. Returns the parsed sidecar
 * only when the file exists, parses, carries a known `version`, AND carries
 * the `type: 'vault-asset'` discriminator. Parse errors, a missing file, an
 * unknown version, or a mismatched/missing `type` (e.g. the unrelated
 * project marker `createProjectFromVault` writes) all yield `null` (the
 * caller falls back to the DB join). Never throws into the listing.
 */
export async function readSidecar(assetDir: string): Promise<VaultSidecar | null> {
  let raw: string
  try {
    raw = await fsp.readFile(path.join(assetDir, SIDECAR_FILENAME), 'utf-8')
  } catch {
    return null
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const p = parsed as Record<string, unknown>
  if (p.version !== KNOWN_VERSION) return null
  if (p.type !== SIDECAR_TYPE) return null
  return {
    version: KNOWN_VERSION,
    type: SIDECAR_TYPE,
    source: (p.source as AssetSource | null) ?? null,
    sourceId: (p.sourceId as string | null) ?? null,
    engineVersion: (p.engineVersion as string | null) ?? null,
    buildVersion: typeof p.buildVersion === 'string' ? p.buildVersion : null,
    title: (p.title as string | null) ?? null,
    kind: (p.kind as LocalVaultKind) ?? 'unknown',
    fabDistributionMethod: (p.fabDistributionMethod as string | null) ?? null,
    downloadedAt: typeof p.downloadedAt === 'number' ? p.downloadedAt : 0
  }
}

/**
 * Write `<assetDir>/.rehoarder.json`. Best-effort: returns `false` and logs
 * on failure (a missing sidecar degrades to today's DB-join behaviour, never
 * a broken listing). The `version` field is stamped here.
 */
export async function writeSidecar(
  assetDir: string,
  data: Omit<VaultSidecar, 'version' | 'type'>
): Promise<boolean> {
  const sidecar: VaultSidecar = { version: KNOWN_VERSION, type: SIDECAR_TYPE, ...data }
  try {
    await fsp.writeFile(
      path.join(assetDir, SIDECAR_FILENAME),
      JSON.stringify(sidecar, null, 2) + '\n',
      'utf-8'
    )
    return true
  } catch (err) {
    console.warn(`[vault-sidecar] could not write ${assetDir}:`, err)
    return false
  }
}
