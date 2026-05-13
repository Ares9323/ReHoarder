import * as path from 'node:path'
import type { AssetsRepo } from '../db/assets-repo'
import type { Session } from '../auth/session'
import type { EpicWebSessionFactory } from '../auth/epic-web-session'
import type { FabSessionClient } from '../fab/fab-session'
import { downloadAsset } from './download-orchestrator'
import { EPIC_USER_AGENT } from '../vault/user-agent'
import {
  fetchManifestLocator,
  downloadManifestBlob,
  extractCloudDirInfo
} from './manifest-client'
import { parseManifest } from './manifest-parser'
import type { DownloadProgress, DownloadResult } from './download-types'

export interface FabRunnerDeps {
  assetsRepo: AssetsRepo
  session: Session
  epicWebSessionFactory: EpicWebSessionFactory
  fabSessionClient: FabSessionClient
  fabFetch: typeof fetch
}

export interface FabRunnerOptions {
  vaultDir: string
  /** Folder name under `vaultDir`. Defaults to artifactId from the manifest locator. */
  assetSubdir?: string
  /** Forwarded to the orchestrator: cumulative progress callback. */
  onProgress?: (p: DownloadProgress) => void
  /** Forwarded to the orchestrator: per-step log line. */
  onLog?: (line: string) => void
  signal?: AbortSignal
}

export interface FabRunnerStartResult {
  artifactId: string
  /** Sum of `fileSize` across the manifest's files — known before any chunk is fetched. */
  bytesTotal: number
  filesTotal: number
  /** Resolved `<vaultDir>/<assetSubdir>/` — known after subdir resolution but BEFORE chunks start. */
  assetDir: string
}

/**
 * Run a full Fab asset download (handshake → manifest → chunks → assemble).
 * Extracted from `debug-ipc.ts` so it can be reused by the persistent
 * `DownloadsManager`. The caller is in charge of progress UI / persistence;
 * we only forward orchestrator events.
 *
 * Returns the orchestrator result on success, or throws (including the
 * `DownloadCancelledError` from the abort signal).
 *
 * The `onStart` callback receives metadata that's available right after the
 * manifest is parsed but BEFORE any chunk has been fetched — perfect for
 * persisting `bytes_total` / `files_total` / `dest_dir` in one shot.
 */
export async function runFabAssetDownload(
  deps: FabRunnerDeps,
  assetId: string,
  opts: FabRunnerOptions,
  onStart?: (info: FabRunnerStartResult) => void
): Promise<DownloadResult & { artifactId: string }> {
  const accessToken = deps.session.getAccessToken()
  if (!accessToken) {
    throw new Error('Not authenticated — log in and run a sync first.')
  }
  const asset = deps.assetsRepo.findById('fab', assetId)
  if (!asset || !asset.raw) {
    throw new Error(`Asset "${assetId}" not found or has no raw JSON.`)
  }
  const raw = JSON.parse(asset.raw) as {
    assetNamespace?: string
    projectVersions?: Array<{ artifactId?: string }>
  }
  const artifactId = raw.projectVersions?.[0]?.artifactId
  const namespace = raw.assetNamespace
  if (!artifactId || !namespace) {
    throw new Error(
      `Asset "${assetId}" raw JSON is missing projectVersions[0].artifactId or assetNamespace.`
    )
  }

  const onLog = opts.onLog ?? (() => {})
  onLog('establishing Fab session…')
  const epicSession = await deps.epicWebSessionFactory.create(accessToken, onLog)
  await deps.fabSessionClient.establishSession(accessToken, epicSession, onLog)
  opts.signal?.throwIfAborted()

  onLog(`requesting manifest for ${artifactId}…`)
  const locator = await fetchManifestLocator(deps.fabFetch, {
    artifactId,
    itemId: assetId,
    namespace,
    platform: 'Windows',
    accessToken
  })
  const blob = await downloadManifestBlob(deps.fabFetch, locator)
  const manifest = parseManifest(blob)
  const infos = locator.distributionPoints.map((p) => extractCloudDirInfo(p.url))
  const baseUris = infos.map((i) => i.baseUri)
  const chunkQueryStrings = infos.map((i) => i.queryString)
  opts.signal?.throwIfAborted()

  const bytesTotal = manifest.files.reduce((acc, f) => acc + f.fileSize, 0)
  const filesTotal = manifest.files.length
  const subdir = opts.assetSubdir ?? artifactId
  const assetDir = path.join(opts.vaultDir, subdir.replace(/[/\\:*?"<>|]/g, '_'))
  onStart?.({ artifactId, bytesTotal, filesTotal, assetDir })

  const result = await downloadAsset(
    { manifest, baseUris, chunkQueryStrings, locator },
    {
      vaultDir: opts.vaultDir,
      assetSubdir: subdir,
      fetchImpl: deps.fabFetch,
      chunkHeaders: {
        Authorization: `bearer ${accessToken}`,
        'User-Agent': EPIC_USER_AGENT
      },
      onLog: opts.onLog,
      onProgress: opts.onProgress,
      signal: opts.signal
    }
  )

  return { ...result, artifactId }
}
