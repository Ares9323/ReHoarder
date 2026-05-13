import { ipcMain, app } from 'electron'
import * as fs from 'node:fs'
import * as path from 'node:path'
import type { AssetsRepo } from '../db/assets-repo'
import type { Session } from '../auth/session'
import type { EpicWebSessionFactory } from '../auth/epic-web-session'
import type { FabSessionClient } from '../fab/fab-session'
import { downloadAsset } from './download-orchestrator'
import {
  fetchManifestLocator,
  downloadManifestBlob,
  extractCloudDirBase
} from './manifest-client'
import { parseManifest } from './manifest-parser'

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
  const accessToken = deps.session.getAccessToken()
  if (!accessToken) {
    return { ok: false, error: 'Not authenticated — log in and run a sync first.' }
  }
  const asset = deps.assetsRepo.findById('fab', assetId)
  if (!asset || !asset.raw) {
    return { ok: false, error: `Asset "${assetId}" not found or has no raw JSON.` }
  }
  const raw = JSON.parse(asset.raw) as {
    assetNamespace?: string
    projectVersions?: Array<{ artifactId?: string }>
  }
  const artifactId = raw.projectVersions?.[0]?.artifactId
  const namespace = raw.assetNamespace
  if (!artifactId || !namespace) {
    return {
      ok: false,
      error: `Asset "${assetId}" raw JSON missing projectVersions[0].artifactId or assetNamespace.`
    }
  }

  console.warn('[debug] establishing Fab session before download…')
  const epicSession = await deps.epicWebSessionFactory.create(accessToken, (m) =>
    console.warn('[debug]', m)
  )
  await deps.fabSessionClient.establishSession(accessToken, epicSession, (m) =>
    console.warn('[debug]', m)
  )

  console.warn(`[debug] requesting manifest + downloading for ${artifactId}`)
  const locator = await fetchManifestLocator(deps.fabFetch, {
    artifactId,
    itemId: assetId,
    namespace,
    platform: 'Windows',
    accessToken
  })
  const blob = await downloadManifestBlob(deps.fabFetch, locator)
  // Save the raw manifest blob FIRST, so if parseManifest() throws we still
  // have the bytes to inspect (e.g. legacy JSON manifests that the v0c parser
  // doesn't yet recognize).
  const debugDir = path.join(app.getPath('userData'), 'debug')
  fs.mkdirSync(debugDir, { recursive: true })
  const safeId = assetId.replace(/[^A-Za-z0-9._-]/g, '_')
  const blobPath = path.join(debugDir, `${safeId}.download-manifest.bin`)
  fs.writeFileSync(blobPath, blob)
  console.warn(`[debug] saved raw manifest blob → ${blobPath} (${blob.length} bytes)`)
  const manifest = parseManifest(blob)
  const baseUris = locator.distributionPoints.map((p) => extractCloudDirBase(p.url))

  const vaultDir = path.join(app.getPath('userData'), 'debug-downloads')
  const result = await downloadAsset(
    { manifest, baseUris, locator },
    {
      vaultDir,
      fetchImpl: deps.fabFetch,
      onLog: (m) => console.warn('[debug]', m),
      onProgress: (p) => {
        if (p.currentFile) console.warn(`[debug] ${p.bytesDone}/${p.bytesTotal} — ${p.currentFile}`)
      }
    }
  )

  return {
    ok: true,
    artifactId,
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
