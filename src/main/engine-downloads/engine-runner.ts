import { downloadAsset } from '../download/download-orchestrator'
import type { Manifest } from '../download/manifest-types'
import type { ManifestBundle } from '../download/manifest-client-types'
import type { DownloadProgress, DownloadResult } from '../download/download-types'
import { EPIC_USER_AGENT } from '../vault/user-agent'
import type { EngineInstallPlan } from './engine-catalog-client'

/**
 * Glue between the engine `EngineInstallPlan` (catalog + parsed manifest)
 * and the existing chunk-download pipeline that already drives Fab asset
 * downloads. The runner filters the manifest's files to the ones whose
 * `InstallTags` intersect with the user's selection (plus the always-on
 * Core, which manifests as files with no `InstallTags`), then hands a
 * `ManifestBundle` to `downloadAsset`.
 *
 * Engine downloads write straight into the install dir (no `data/` wrapping
 * — the manifest's file tree is the engine layout) and use the Epic CDN,
 * which requires a real `EpicGamesLauncher/…` User-Agent on every chunk
 * GET (same regression that broke the launcher download-info call).
 */

export interface EngineRunnerOptions {
  /** Absolute install dir — files land directly under here. */
  installDir: string
  /** InstallTag names the user has chosen (e.g. `templates`, `engine_source`,
   *  `platform_Android`). The empty-string Core tag isn't checked here — it
   *  filters in automatically because files with no `installTags` are always
   *  kept. */
  selectedTags: Set<string>
  signal?: AbortSignal
  onLog?: (line: string) => void
  onProgress?: (p: DownloadProgress) => void
  /** Fires after the plan is filtered but BEFORE any chunk is fetched —
   *  perfect for persisting `bytes_total` / `files_total` on the queue row. */
  onStart?: (info: {
    appName: string
    buildVersion: string
    bytesTotal: number
    filesTotal: number
    installDir: string
  }) => void
}

/**
 * Drop every file from the manifest that doesn't intersect with the user's
 * tag selection. Files whose `installTags` is empty are always kept — that's
 * how Epic encodes "Core, always installed". The function returns a fresh
 * `Manifest` instance with the filtered file list; `chunks` and `meta` are
 * preserved verbatim so the chunk resolver still finds every chunk a kept
 * file references (orphan chunks are simply never fetched).
 */
export function filterManifestByTags(
  manifest: Manifest,
  selectedTags: Set<string>
): Manifest {
  const keep = manifest.files.filter((f) => {
    if (!f.installTags || f.installTags.length === 0) return true
    return f.installTags.some((t) => selectedTags.has(t))
  })
  return { ...manifest, files: keep }
}

export async function runEngineDownload(
  plan: EngineInstallPlan,
  opts: EngineRunnerOptions
): Promise<DownloadResult> {
  const filteredManifest = filterManifestByTags(plan.manifest, opts.selectedTags)
  const filesTotal = filteredManifest.files.length
  const bytesTotal = filteredManifest.files.reduce((acc, f) => acc + (f.fileSize ?? 0), 0)
  opts.onStart?.({
    appName: plan.appName,
    buildVersion: plan.buildVersion,
    bytesTotal,
    filesTotal,
    installDir: opts.installDir
  })
  const bundle: ManifestBundle = {
    manifest: filteredManifest,
    baseUris: plan.baseUris,
    chunkQueryStrings: plan.chunkQueryStrings,
    locator: {
      artifactId: plan.appName,
      manifestHash: plan.manifestHash.toUpperCase(),
      // `downloadAsset` only consumes `bundle.baseUris[0]` today, so the
      // locator's `distributionPoints` field doesn't need every CDN URL —
      // the first one is what gets exercised. Future multi-CDN fallback
      // (task 0.1.3+) will plumb the rest.
      distributionPoints: plan.baseUris.map((u) => ({ url: u }))
    }
  }
  return await downloadAsset(bundle, {
    fetchImpl: fetch,
    vaultDir: opts.installDir,
    assetSubdir: '',
    noWrapDataDir: true,
    // Engine chunks live on Epic's CDN, which 403s any request that doesn't
    // look like the Epic Games Launcher. Same UA gate we hit on the
    // launcher download-info endpoint.
    chunkHeaders: { 'User-Agent': EPIC_USER_AGENT },
    signal: opts.signal,
    onLog: opts.onLog,
    onProgress: opts.onProgress
  })
}
