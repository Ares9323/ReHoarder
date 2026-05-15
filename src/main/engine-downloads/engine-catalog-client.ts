import { createHash } from 'node:crypto'
import { downloadManifestBlob } from '../download/manifest-client'
import { parseManifest } from '../download/manifest-parser'
import type { Manifest } from '../download/manifest-types'
import { EPIC_USER_AGENT } from '../vault/user-agent'
import { VaultClient } from '../vault/vault-client'
import type { TagHistogramEntry } from './install-tags'

/**
 * Production wrapper around Epic's launcher download endpoints, scoped to
 * engine SKUs. The discovery dance behind it (see
 * `src/main/download/debug-ipc.ts` history) established that engines come
 * back from `/launcher/api/public/assets/{platform}?label=Live` with
 * `namespace="ue"` and `appName=UE_<X.Y>`, and that the
 * `/assets/v2/.../label/Live` download-info path REQUIRES a real
 * `EpicGamesLauncher/...` User-Agent — sending a stub UA returns HTTP 403
 * `missing_permission` despite the token having the right scope.
 */

export interface EngineSku {
  /** `UE_5.8`, `UE_4.27`, etc. */
  appName: string
  /** Epic catalog item id, used in the download-info URL. */
  catalogItemId: string
  /** Always `ue` for engine SKUs but kept on the type for symmetry. */
  namespace: string
  /** Full build version string returned by the launcher (`5.8.0-…`). */
  buildVersion: string
  /** Major.minor reduced from `buildVersion` for display + dedup. */
  shortVersion: string
}

/** Return every engine SKU the signed-in user owns. */
export async function listOwnedEngines(accessToken: string): Promise<EngineSku[]> {
  const client = new VaultClient()
  const assets = await client.listOwnedAssets(accessToken)
  const engines: EngineSku[] = []
  for (const a of assets) {
    if (a.namespace !== 'ue') continue
    if (!/^UE_\d+(\.\d+)?$/.test(a.appName)) continue
    const buildVersion = a.buildVersion ?? ''
    engines.push({
      appName: a.appName,
      catalogItemId: a.catalogItemId,
      namespace: a.namespace,
      buildVersion,
      shortVersion: shortVersion(buildVersion, a.appName)
    })
  }
  // Sort newest-major-version first, then by minor — UE_5.x ahead of UE_4.x.
  engines.sort((a, b) => compareVersions(b.shortVersion, a.shortVersion))
  return engines
}

/**
 * Reduce a full build-version (`5.8.0-53629095+++UE5+Release-5.8-Windows`)
 * to the short `5.8` form. Falls back to parsing the appName when the
 * buildVersion is missing or unrecognised.
 */
function shortVersion(buildVersion: string, appName: string): string {
  const fromBuild = /^(\d+)\.(\d+)/.exec(buildVersion)
  if (fromBuild) return `${fromBuild[1]}.${fromBuild[2]}`
  const fromApp = /^UE_(\d+)(?:\.(\d+))?$/.exec(appName)
  if (fromApp) return fromApp[2] ? `${fromApp[1]}.${fromApp[2]}` : fromApp[1]
  return appName
}

function compareVersions(a: string, b: string): number {
  const [aMaj, aMin = '0'] = a.split('.')
  const [bMaj, bMin = '0'] = b.split('.')
  const dm = (Number(aMaj) || 0) - (Number(bMaj) || 0)
  if (dm !== 0) return dm
  return (Number(aMin) || 0) - (Number(bMin) || 0)
}

export interface EngineDownloadElement {
  manifests: Array<{
    uri: string
    queryParams?: Array<{ name: string; value: string }>
  }>
  hash: string
  buildVersion: string
  appName: string
}

/**
 * GET the launcher download-info endpoint for a given engine SKU. Returns
 * the first (and typically only) `elements[0]` entry that carries the
 * manifest URLs + SHA1. Throws on non-2xx with the response body for
 * easier debugging.
 */
export async function fetchEngineDownloadInfo(
  accessToken: string,
  sku: { namespace: string; catalogItemId: string; appName: string },
  platform = 'Windows'
): Promise<EngineDownloadElement> {
  // The endpoint expects the bare `Live` label, not `Live-Windows` — verified
  // against AMS' `getBuildInfo` and against a 403 we hit while passing the
  // suffixed label.
  const url =
    `https://launcher-public-service-prod06.ol.epicgames.com/launcher/api/public/assets/v2` +
    `/platform/${encodeURIComponent(platform)}` +
    `/namespace/${encodeURIComponent(sku.namespace)}` +
    `/catalogItem/${encodeURIComponent(sku.catalogItemId)}` +
    `/app/${encodeURIComponent(sku.appName)}/label/Live`
  const response = await fetch(url, {
    method: 'GET',
    headers: {
      'User-Agent': EPIC_USER_AGENT,
      Authorization: `bearer ${accessToken}`,
      Accept: 'application/json'
    }
  })
  if (!response.ok) {
    const body = await response.text()
    throw new Error(
      `Launcher download-info returned HTTP ${response.status} for ${sku.appName}: ${body.slice(0, 400)}`
    )
  }
  const json = (await response.json()) as {
    elements?: Array<{
      appName?: string
      buildVersion?: string
      hash?: string
      manifests?: Array<{
        uri: string
        queryParams?: Array<{ name: string; value: string }>
      }>
    }>
  }
  const first = json.elements?.[0]
  if (!first || !first.hash || !first.manifests || first.manifests.length === 0) {
    throw new Error(`Launcher download-info returned no manifests for ${sku.appName}`)
  }
  return {
    manifests: first.manifests,
    hash: first.hash,
    buildVersion: first.buildVersion ?? '',
    appName: first.appName ?? sku.appName
  }
}

export interface EngineInstallPlan {
  appName: string
  buildVersion: string
  manifestHash: string
  manifest: Manifest
  /** CDN base URIs (signed, time-limited) suitable for chunk fetches. */
  baseUris: string[]
  /** Signed query strings to append to each chunk URL, paired by index
   *  with `baseUris`. */
  chunkQueryStrings: string[]
  /** Per-installTag aggregate, sorted as it comes back from the manifest
   *  — the renderer reorders via `describeComponents`. */
  installTagsHistogram: TagHistogramEntry[]
  /** Sum of `chunk.fileSize` (compressed bytes on the CDN) — useful for
   *  a "Download size" footer once a tag selection is computed. */
  totalCompressedBytes: number
  /** Sum of `file.fileSize` across every file. Used for "Required storage
   *  space (decompressed)". */
  totalDecompressedBytes: number
}

/**
 * Full install-plan fetch: hit the download-info endpoint, fetch the
 * binary manifest from one of the CDN points, parse it, and produce the
 * histogram + base URIs needed by both the renderer (for the components
 * dialog) and the chunk runner (when the user confirms install).
 */
export async function fetchEngineInstallPlan(
  accessToken: string,
  sku: { namespace: string; catalogItemId: string; appName: string },
  platform = 'Windows'
): Promise<EngineInstallPlan> {
  const info = await fetchEngineDownloadInfo(accessToken, sku, platform)
  const distributionPoints = info.manifests.map((m) => {
    const q = (m.queryParams ?? []).map((p) => `${p.name}=${p.value}`).join('&')
    return { url: q.length > 0 ? `${m.uri}?${q}` : m.uri }
  })
  const blob = await downloadManifestBlob(fetch, {
    artifactId: sku.appName,
    manifestHash: info.hash.toUpperCase(),
    distributionPoints
  })
  // Defence-in-depth — `downloadManifestBlob` already verifies, but a
  // double-check pins the contract even if a future refactor drops the
  // check there.
  const actual = createHash('sha1').update(blob).digest('hex').toLowerCase()
  if (actual !== info.hash.toLowerCase()) {
    throw new Error(`Manifest SHA1 mismatch for ${sku.appName}: ${actual} ≠ ${info.hash}`)
  }
  const manifest = parseManifest(blob)
  const tagAgg = new Map<string, { fileCount: number; bytes: number }>()
  let totalDecompressedBytes = 0
  for (const f of manifest.files) {
    const tags = f.installTags && f.installTags.length > 0 ? f.installTags : ['']
    const size = f.fileSize ?? 0
    totalDecompressedBytes += size
    for (const tag of tags) {
      const cur = tagAgg.get(tag) ?? { fileCount: 0, bytes: 0 }
      cur.fileCount += 1
      cur.bytes += size
      tagAgg.set(tag, cur)
    }
  }
  const totalCompressedBytes = manifest.chunks.reduce((acc, c) => acc + (c.fileSize ?? 0), 0)
  const baseUris: string[] = []
  const chunkQueryStrings: string[] = []
  for (const p of distributionPoints) {
    const { base, query } = splitCloudDir(p.url)
    baseUris.push(base)
    chunkQueryStrings.push(query)
  }
  return {
    appName: info.appName,
    buildVersion: info.buildVersion,
    manifestHash: info.hash,
    manifest,
    baseUris,
    chunkQueryStrings,
    installTagsHistogram: Array.from(tagAgg.entries())
      .map(([tag, v]) => ({ tag, fileCount: v.fileCount, bytes: v.bytes }))
      .sort((a, b) => b.bytes - a.bytes),
    totalCompressedBytes,
    totalDecompressedBytes
  }
}

/** Splits an Epic CDN manifest URL into `<base>CloudDir/` + the trailing
 *  signed query. Mirrors `extractCloudDirInfo` in `manifest-client.ts` but
 *  inlined here to keep the engine module self-contained — the file isn't
 *  reachable as a CommonJS dep cleanly from this folder yet.
 */
function splitCloudDir(url: string): { base: string; query: string } {
  const SEG = 'CloudDir'
  const idx = url.indexOf(SEG)
  if (idx < 0) {
    throw new Error(`Manifest URL has no CloudDir segment: ${url}`)
  }
  const base = url.slice(0, idx + SEG.length + 1) // include trailing slash
  const qIdx = url.indexOf('?')
  const query = qIdx > 0 ? url.slice(qIdx) : ''
  return { base, query }
}
