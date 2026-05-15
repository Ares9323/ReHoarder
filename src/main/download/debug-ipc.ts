import { ipcMain, app } from 'electron'
import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import type { AssetsRepo } from '../db/assets-repo'
import type { Session } from '../auth/session'
import type { EpicWebSessionFactory } from '../auth/epic-web-session'
import type { FabSessionClient } from '../fab/fab-session'
import { VaultClient, type CatalogItem, type VaultAssetSummary } from '../vault/vault-client'
import { EPIC_USER_AGENT } from '../vault/user-agent'
import {
  fetchManifestLocator,
  downloadManifestBlob,
  extractCloudDirBase
} from './manifest-client'
import { parseManifest } from './manifest-parser'
import { runFabAssetDownload } from './fab-asset-runner'

interface DebugDeps {
  assetsRepo: AssetsRepo
  session: Session
  epicWebSessionFactory: EpicWebSessionFactory
  fabSessionClient: FabSessionClient
  fabFetch: typeof fetch
  /** Base `userData` dir; debug artifacts go in `<debugDir>/debug/`. */
  debugDir: string
}

interface SampleManifestResult {
  ok: boolean
  error?: string
  assetId?: string
  artifactId?: string
  manifestHash?: string
  blobBytes?: number
  baseUris?: string[]
  fileCount?: number
  chunkCount?: number
  totalFileSize?: number
  savedBlobPath?: string
  savedJsonPath?: string
}

/**
 * Register a developer-only IPC handler that fetches a single Fab manifest
 * end-to-end for a given assetId and persists both the raw binary blob and
 * the parsed JSON to `<userData>/debug/`. Used to validate the v0a parser
 * against real-world payloads without yet having a UI for downloads.
 *
 * Invoke from the renderer DevTools console:
 *
 *     await window.api.debug.fetchSampleManifest('<assetId>')
 */
export function registerDebugIpc(deps: DebugDeps): void {
  ipcMain.handle(
    'debug:fetch-sample-manifest',
    async (_event, assetId: string): Promise<SampleManifestResult> => {
      try {
        const result = await fetchSampleManifest(deps, assetId)
        return result
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.error('[debug] fetch-sample-manifest failed:', msg)
        return { ok: false, error: msg }
      }
    }
  )

  ipcMain.handle(
    'debug:clear-library',
    async (
      _event,
      opts: { sources?: Array<'vault' | 'fab' | 'legacy'> } = {}
    ): Promise<DebugClearLibraryResult> => {
      try {
        return clearLibrary(deps, opts.sources)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.error('[debug] clear-library failed:', msg)
        return { ok: false, error: msg }
      }
    }
  )

  registerDebugDownloadIpc(deps)
  registerEngineDiscoveryIpc(deps)
}

// -----------------------------------------------------------------------------
// Engine-download discovery (early-exploration debug IPCs)
// -----------------------------------------------------------------------------
//
// These dump raw Epic launcher API responses to `<userData>/debug/` so we can
// inspect the shape engine SKUs come in (catalog categories, appName pattern,
// download-info elements, etc.) before designing the production engine
// catalog client. They'll be replaced by a real `EngineCatalogClient` once
// we know what the data looks like in practice.

export interface DebugLauncherCatalogResult {
  ok: boolean
  error?: string
  totalAssets?: number
  /** SKUs whose catalog metadata or appName looks engine-shaped. Best-guess
   *  filter — the dumped JSON has the full data for cross-checking. */
  engineCandidates?: Array<{
    namespace: string
    catalogItemId: string
    appName: string
    labelName: string
    buildVersion?: string
    title?: string
    categoryPaths?: string[]
  }>
  /** Absolute path of the JSON dump (every asset + its catalog metadata). */
  savedDumpPath?: string
}

export interface DebugEngineDownloadInfoResult {
  ok: boolean
  error?: string
  /** HTTP status of the launcher call, even on failure (helps debug auth). */
  status?: number
  /** Absolute path of the raw JSON dump. */
  savedJsonPath?: string
  /** First manifest URL surfaced from the response, if any (best-effort
   *  extraction since the shape may differ between Fab and the launcher
   *  catalog endpoint). */
  firstManifestUrl?: string
}

function registerEngineDiscoveryIpc(deps: DebugDeps): void {
  ipcMain.handle(
    'debug:list-launcher-catalog',
    async (): Promise<DebugLauncherCatalogResult> => {
      try {
        return await listLauncherCatalog(deps)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.error('[debug] list-launcher-catalog failed:', msg)
        return { ok: false, error: msg }
      }
    }
  )

  ipcMain.handle(
    'debug:fetch-engine-download-info',
    async (
      _event,
      args: {
        namespace: string
        catalogItemId: string
        appName: string
        platform?: string
        labelName?: string
      }
    ): Promise<DebugEngineDownloadInfoResult> => {
      try {
        return await fetchEngineDownloadInfo(deps, args)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.error('[debug] fetch-engine-download-info failed:', msg)
        return { ok: false, error: msg }
      }
    }
  )

  ipcMain.handle(
    'debug:fetch-engine-manifest',
    async (
      _event,
      args: {
        namespace: string
        catalogItemId: string
        appName: string
        platform?: string
        labelName?: string
      }
    ): Promise<DebugEngineManifestResult> => {
      try {
        return await fetchEngineManifest(deps, args)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.error('[debug] fetch-engine-manifest failed:', msg)
        return { ok: false, error: msg }
      }
    }
  )
}

export interface DebugEngineManifestResult {
  ok: boolean
  error?: string
  appName?: string
  buildVersion?: string
  /** SHA1 hex (lowercase) of the downloaded manifest binary. */
  manifestHash?: string
  blobBytes?: number
  fileCount?: number
  chunkCount?: number
  totalFileSize?: number
  /** Distinct `InstallTags` values found across all files — drives the
   *  components-picker design (Core / Templates / Editor symbols / per
   *  target platform / MetaHuman). */
  installTagsHistogram?: Array<{ tag: string; fileCount: number; bytes: number }>
  baseUris?: string[]
  savedBlobPath?: string
  savedJsonPath?: string
}

async function fetchEngineManifest(
  deps: DebugDeps,
  args: {
    namespace: string
    catalogItemId: string
    appName: string
    platform?: string
    labelName?: string
  }
): Promise<DebugEngineManifestResult> {
  const accessToken = deps.session.getAccessToken()
  if (!accessToken) {
    return { ok: false, error: 'Not authenticated — log in first.' }
  }
  const platform = args.platform ?? 'Windows'
  const labelName = args.labelName ?? 'Live'
  const url =
    `https://launcher-public-service-prod06.ol.epicgames.com/launcher/api/public/assets/v2` +
    `/platform/${encodeURIComponent(platform)}` +
    `/namespace/${encodeURIComponent(args.namespace)}` +
    `/catalogItem/${encodeURIComponent(args.catalogItemId)}` +
    `/app/${encodeURIComponent(args.appName)}/label/${encodeURIComponent(labelName)}`
  const infoResp = await fetch(url, {
    method: 'GET',
    headers: {
      'User-Agent': EPIC_USER_AGENT,
      Authorization: `bearer ${accessToken}`,
      Accept: 'application/json'
    }
  })
  if (!infoResp.ok) {
    return { ok: false, error: `Download-info call returned HTTP ${infoResp.status}` }
  }
  const infoJson = (await infoResp.json()) as {
    elements?: Array<{
      buildVersion?: string
      hash?: string
      manifests?: Array<{
        uri: string
        queryParams?: Array<{ name: string; value: string }>
      }>
    }>
  }
  const first = infoJson.elements?.[0]
  if (!first || !first.hash || !first.manifests || first.manifests.length === 0) {
    return { ok: false, error: 'Download-info response had no elements[0].manifests entries' }
  }
  const distributionPoints = first.manifests.map((m) => {
    const q = (m.queryParams ?? []).map((p) => `${p.name}=${p.value}`).join('&')
    return { url: q.length > 0 ? `${m.uri}?${q}` : m.uri }
  })
  let blob: Buffer
  try {
    blob = await downloadManifestBlob(fetch, {
      artifactId: args.appName,
      manifestHash: first.hash.toUpperCase(),
      distributionPoints
    })
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
  let parsed: ReturnType<typeof parseManifest>
  try {
    parsed = parseManifest(blob)
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }

  // Tag histogram — every file in an engine manifest carries one or more
  // `InstallTags`. The unique values (and how big they are) tell us which
  // logical components Epic ships under each tag, which directly informs
  // the components-picker UI.
  const tagAgg = new Map<string, { files: number; bytes: number }>()
  for (const f of parsed.files) {
    const tags = f.installTags && f.installTags.length > 0 ? f.installTags : ['']
    const size = f.fileSize ?? 0
    for (const tag of tags) {
      const cur = tagAgg.get(tag) ?? { files: 0, bytes: 0 }
      cur.files += 1
      cur.bytes += size
      tagAgg.set(tag, cur)
    }
  }
  const installTagsHistogram = Array.from(tagAgg.entries())
    .map(([tag, v]) => ({ tag, fileCount: v.files, bytes: v.bytes }))
    .sort((a, b) => b.bytes - a.bytes)

  const debugDir = path.join(app.getPath('userData'), 'debug')
  fs.mkdirSync(debugDir, { recursive: true })
  const safeName = `${args.appName}-${createHash('sha1')
    .update(`${args.namespace}:${args.catalogItemId}`)
    .digest('hex')
    .slice(0, 8)}`.replace(/[^A-Za-z0-9._-]/g, '_')
  const blobPath = path.join(debugDir, `engine-manifest-${safeName}.manifest`)
  const jsonPath = path.join(debugDir, `engine-manifest-${safeName}.json`)
  fs.writeFileSync(blobPath, blob)
  fs.writeFileSync(jsonPath, JSON.stringify(parsed, null, 2), 'utf-8')

  return {
    ok: true,
    appName: args.appName,
    buildVersion: first.buildVersion,
    manifestHash: first.hash,
    blobBytes: blob.length,
    fileCount: parsed.files.length,
    chunkCount: parsed.chunks.length,
    totalFileSize: parsed.files.reduce((acc, f) => acc + (f.fileSize ?? 0), 0),
    installTagsHistogram,
    baseUris: distributionPoints.map((d) => {
      try {
        return extractCloudDirBase(d.url)
      } catch {
        return d.url
      }
    }),
    savedBlobPath: blobPath,
    savedJsonPath: jsonPath
  }
}

async function listLauncherCatalog(
  deps: DebugDeps
): Promise<DebugLauncherCatalogResult> {
  const accessToken = deps.session.getAccessToken()
  if (!accessToken) {
    return { ok: false, error: 'Not authenticated — log in first.' }
  }
  const vaultClient = new VaultClient()
  const assets = await vaultClient.listOwnedAssets(accessToken)
  // Catalog metadata in bulk — needed to surface the human-friendly title +
  // categories for each SKU. Engines typically come back with a category
  // path containing `engines` (e.g. `engines/unreal`).
  const catalogIds = Array.from(new Set(assets.map((a) => a.catalogItemId)))
  const metadata = await vaultClient.fetchCatalogMetadata(accessToken, catalogIds)
  const enriched = assets.map((a) => ({
    asset: a,
    catalog: metadata[a.catalogItemId] ?? null
  }))
  const engineCandidates = enriched
    .filter(({ asset, catalog }) => isEngineShaped(asset, catalog))
    .map(({ asset, catalog }) => ({
      namespace: asset.namespace,
      catalogItemId: asset.catalogItemId,
      appName: asset.appName,
      labelName: asset.labelName,
      buildVersion: asset.buildVersion,
      title: catalog?.title,
      categoryPaths: catalog?.categories?.map((c) => c.path) ?? []
    }))
  const debugDir = path.join(app.getPath('userData'), 'debug')
  fs.mkdirSync(debugDir, { recursive: true })
  const dumpPath = path.join(debugDir, 'launcher-catalog.json')
  fs.writeFileSync(
    dumpPath,
    JSON.stringify(
      { generatedAt: new Date().toISOString(), assets: enriched },
      null,
      2
    ),
    'utf-8'
  )
  return {
    ok: true,
    totalAssets: assets.length,
    engineCandidates,
    savedDumpPath: dumpPath
  }
}

/** Engine SKUs are stamped as `namespace="ue"` with an `appName` like
 *  `UE_5.6`, `UE_4.27`, etc. Verified against an account with 39 owned
 *  engines on 2026-05-15 — every other namespace value covers asset packs
 *  or third-party launcher items, and the `asset-format/game-engine/...`
 *  category paths on asset packs would false-positive an `engine`-keyword
 *  filter, so the `appName` shape is the only reliable discriminator. */
function isEngineShaped(asset: VaultAssetSummary, _catalog: CatalogItem | null): boolean {
  return asset.namespace === 'ue' && /^UE_\d+(\.\d+)?$/.test(asset.appName)
}

async function fetchEngineDownloadInfo(
  deps: DebugDeps,
  args: {
    namespace: string
    catalogItemId: string
    appName: string
    platform?: string
    labelName?: string
  }
): Promise<DebugEngineDownloadInfoResult> {
  const accessToken = deps.session.getAccessToken()
  if (!accessToken) {
    return { ok: false, error: 'Not authenticated — log in first.' }
  }
  const platform = args.platform ?? 'Windows'
  // Although `listOwnedAssets` returns `labelName: "Live-Windows"` for engine
  // SKUs, the `/assets/v2/.../label/...` endpoint expects the bare `Live`
  // (verified against AMS 1.2.0's `getBuildInfo` and against a 403 we got
  // here when we tried `Live-Windows`). Caller can override if a future
  // platform-suffixed label ever ships.
  const labelName = args.labelName ?? 'Live'
  const url =
    `https://launcher-public-service-prod06.ol.epicgames.com/launcher/api/public/assets/v2` +
    `/platform/${encodeURIComponent(platform)}` +
    `/namespace/${encodeURIComponent(args.namespace)}` +
    `/catalogItem/${encodeURIComponent(args.catalogItemId)}` +
    `/app/${encodeURIComponent(args.appName)}/label/${encodeURIComponent(labelName)}`
  const response = await fetch(url, {
    method: 'GET',
    headers: {
      // Required: the engine download-info path rejects requests without a
      // real Epic Games Launcher UA shape with HTTP 403 + `missing_permission`.
      'User-Agent': EPIC_USER_AGENT,
      Authorization: `bearer ${accessToken}`,
      Accept: 'application/json'
    }
  })
  const status = response.status
  const text = await response.text()
  const debugDir = path.join(app.getPath('userData'), 'debug')
  fs.mkdirSync(debugDir, { recursive: true })
  const safeName = `${args.appName}-${createHash('sha1')
    .update(`${args.namespace}:${args.catalogItemId}`)
    .digest('hex')
    .slice(0, 8)}`.replace(/[^A-Za-z0-9._-]/g, '_')
  const dumpPath = path.join(debugDir, `engine-download-info-${safeName}.json`)
  fs.writeFileSync(dumpPath, text, 'utf-8')
  if (!response.ok) {
    return { ok: false, status, savedJsonPath: dumpPath, error: `HTTP ${status}` }
  }
  // Best-effort manifest URL extraction so the user has something to copy
  // into the next IPC without grepping the JSON by hand.
  let firstManifestUrl: string | undefined
  try {
    const parsed = JSON.parse(text)
    firstManifestUrl =
      pickFirstManifestUrl(parsed?.elements?.[0]) ??
      pickFirstManifestUrl(parsed?.downloadInfo?.[0])
  } catch {
    /* ignore — dump file still has the raw response */
  }
  return { ok: true, status, savedJsonPath: dumpPath, firstManifestUrl }
}

/** Try the two known response shapes — `elements[0].manifests[].uri` (Epic
 *  launcher catalog) and `downloadInfo[0].distributionPoints[].manifestUrl`
 *  (Fab) — and return the first usable URL we find. */
function pickFirstManifestUrl(entry: unknown): string | undefined {
  if (!entry || typeof entry !== 'object') return undefined
  const e = entry as Record<string, unknown>
  const manifests = e.manifests as unknown[] | undefined
  if (Array.isArray(manifests) && manifests.length > 0) {
    const first = manifests[0] as Record<string, unknown> | undefined
    if (first && typeof first.uri === 'string') {
      const queryParams = first.queryParams as Array<{ name: string; value: string }> | undefined
      if (queryParams && queryParams.length > 0) {
        const q = queryParams.map((p) => `${p.name}=${p.value}`).join('&')
        return `${first.uri}?${q}`
      }
      return first.uri
    }
  }
  const dists = e.distributionPoints as unknown[] | undefined
  if (Array.isArray(dists) && dists.length > 0) {
    const first = dists[0] as Record<string, unknown> | undefined
    if (first && typeof first.manifestUrl === 'string') return first.manifestUrl
    if (first && typeof first.uri === 'string') return first.uri as string
  }
  return undefined
}

export interface DebugClearLibraryResult {
  ok: boolean
  error?: string
  /** Rows removed from `assets`. */
  assetsRemoved?: number
  /** Rows removed from `asset_tags`. */
  tagsRemoved?: number
  /** sync_state rows that were reset (re-enables full sync). */
  syncStateRowsReset?: number
}

function clearLibrary(
  deps: DebugDeps,
  sources?: Array<'vault' | 'fab' | 'legacy'>
): DebugClearLibraryResult {
  const db = deps.assetsRepo.db
  const txn = db.transaction(() => {
    let assetsRemoved = 0
    let tagsRemoved = 0
    let syncStateRowsReset = 0
    if (!sources || sources.length === 0) {
      tagsRemoved = (db.prepare('DELETE FROM asset_tags').run().changes ?? 0) as number
      assetsRemoved = (db.prepare('DELETE FROM assets').run().changes ?? 0) as number
      syncStateRowsReset = (db.prepare('DELETE FROM sync_state').run().changes ?? 0) as number
    } else {
      const placeholders = sources.map(() => '?').join(',')
      tagsRemoved = (db
        .prepare(`DELETE FROM asset_tags WHERE source IN (${placeholders})`)
        .run(...sources).changes ?? 0) as number
      assetsRemoved = (db
        .prepare(`DELETE FROM assets WHERE source IN (${placeholders})`)
        .run(...sources).changes ?? 0) as number
      syncStateRowsReset = (db
        .prepare(`DELETE FROM sync_state WHERE source IN (${placeholders})`)
        .run(...sources).changes ?? 0) as number
    }
    return { assetsRemoved, tagsRemoved, syncStateRowsReset }
  })
  const result = txn()
  console.warn(
    `[debug] clear-library: removed ${result.assetsRemoved} assets, ` +
      `${result.tagsRemoved} tags, ${result.syncStateRowsReset} sync_state rows ` +
      `(sources=${sources?.join(',') ?? 'ALL'})`
  )
  return { ok: true, ...result }
}

export interface DebugDownloadSampleAssetResult {
  ok: boolean
  error?: string
  artifactId?: string
  dataDir?: string
  fileCount?: number
  bytesWritten?: number
  durationMs?: number
  firstFiles?: Array<{ filename: string; size: number; skipped: boolean }>
}

/**
 * Register `debug:download-sample-asset` so the renderer's DevTools console
 * can trigger a full end-to-end download against the live Fab CDN. Saves
 * everything into `<userData>/debug-downloads/<artifactId>/data/`.
 *
 * Sample usage (from DevTools console):
 *   await window.api.debug.downloadSampleAsset('<assetId>')
 */
export function registerDebugDownloadIpc(deps: DebugDeps): void {
  ipcMain.handle(
    'debug:download-sample-asset',
    async (_event, assetId: string): Promise<DebugDownloadSampleAssetResult> => {
      try {
        return await runDebugDownload(deps, assetId)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.error('[debug] download-sample-asset failed:', msg)
        return { ok: false, error: msg }
      }
    }
  )
}

async function runDebugDownload(
  deps: DebugDeps,
  assetId: string
): Promise<DebugDownloadSampleAssetResult> {
  const vaultDir = path.join(app.getPath('userData'), 'debug-downloads')
  const result = await runFabAssetDownload(deps, assetId, {
    vaultDir,
    onLog: (m) => console.warn('[debug]', m),
    onProgress: (p) => {
      if (p.currentFile) console.warn(`[debug] ${p.bytesDone}/${p.bytesTotal} — ${p.currentFile}`)
    }
  })
  return {
    ok: true,
    artifactId: result.artifactId,
    dataDir: result.dataDir,
    fileCount: result.files.length,
    bytesWritten: result.bytesWritten,
    durationMs: result.durationMs,
    firstFiles: result.files
      .slice(0, 10)
      .map((f) => ({ filename: f.filename, size: f.fileSize, skipped: f.skipped }))
  }
}

async function fetchSampleManifest(
  deps: DebugDeps,
  assetId: string
): Promise<SampleManifestResult> {
  const accessToken = deps.session.getAccessToken()
  if (!accessToken) {
    return { ok: false, error: 'Not authenticated — log in and run a sync first.' }
  }
  const asset = deps.assetsRepo.findById('fab', assetId)
  if (!asset) {
    return { ok: false, error: `Asset "${assetId}" not found (source=fab).` }
  }
  if (!asset.raw) {
    return { ok: false, error: `Asset "${assetId}" has no cached raw JSON.` }
  }
  let raw: {
    assetNamespace?: string
    projectVersions?: Array<{ artifactId?: string }>
  }
  try {
    raw = JSON.parse(asset.raw)
  } catch (err) {
    return {
      ok: false,
      error: `Could not parse raw JSON for "${assetId}": ${err instanceof Error ? err.message : String(err)}`
    }
  }
  const artifactId = raw.projectVersions?.[0]?.artifactId
  const namespace = raw.assetNamespace
  if (!artifactId) {
    return { ok: false, error: `Asset "${assetId}" raw JSON has no projectVersions[0].artifactId.` }
  }
  if (!namespace) {
    return { ok: false, error: `Asset "${assetId}" raw JSON has no assetNamespace.` }
  }

  // Ensure a fresh Fab session so the partition has valid cookies / cf_clearance.
  // Without this, fabFetch would talk to fab.com unauthenticated.
  console.warn('[debug] establishing Fab session before manifest fetch…')
  const epicSession = await deps.epicWebSessionFactory.create(accessToken, (m) =>
    console.warn('[debug]', m)
  )
  await deps.fabSessionClient.establishSession(accessToken, epicSession, (m) =>
    console.warn('[debug]', m)
  )

  console.warn(`[debug] requesting manifest for ${artifactId} (item=${assetId})`)
  const locator = await fetchManifestLocator(deps.fabFetch, {
    artifactId,
    itemId: assetId,
    namespace,
    platform: 'Windows',
    accessToken
  })
  const blob = await downloadManifestBlob(deps.fabFetch, locator)
  const manifest = parseManifest(blob)
  const baseUris = locator.distributionPoints.map((p) => extractCloudDirBase(p.url))

  const outDir = path.join(deps.debugDir, 'debug')
  fs.mkdirSync(outDir, { recursive: true })
  const safeId = assetId.replace(/[^A-Za-z0-9._-]/g, '_')
  const blobPath = path.join(outDir, `${safeId}.manifest.bin`)
  const jsonPath = path.join(outDir, `${safeId}.manifest.json`)
  fs.writeFileSync(blobPath, blob)
  fs.writeFileSync(
    jsonPath,
    JSON.stringify(
      { locator, baseUris, manifest },
      (_key, value) => (typeof value === 'bigint' ? value.toString() : value),
      2
    )
  )

  const totalFileSize = manifest.files.reduce((acc, f) => acc + f.fileSize, 0)
  console.warn(
    `[debug] manifest OK: ${manifest.files.length} files, ${manifest.chunks.length} chunks, ${totalFileSize} bytes total`
  )
  console.warn(`[debug] saved blob → ${blobPath}`)
  console.warn(`[debug] saved JSON → ${jsonPath}`)

  return {
    ok: true,
    assetId,
    artifactId,
    manifestHash: locator.manifestHash,
    blobBytes: blob.length,
    baseUris,
    fileCount: manifest.files.length,
    chunkCount: manifest.chunks.length,
    totalFileSize,
    savedBlobPath: blobPath,
    savedJsonPath: jsonPath
  }
}
