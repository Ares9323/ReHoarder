import { promises as fsp } from 'node:fs'
import * as path from 'node:path'
import { ChunkSource, type ChunkSourceStats } from './chunk-source'
import { assembleFile, isFileAlreadyValid } from './file-assembler'
import { ChunkPrefetcher, normalizeChunkConcurrency } from './chunk-prefetcher'
import { compilePatterns, matchesAny } from './cruft-filter'
import type { ManifestBundle } from './manifest-client-types'
import type { FileManifestEntry, Manifest } from './manifest-types'
import {
  DownloadCancelledError,
  type DownloadOptions,
  type DownloadResult,
  type DownloadFileSummary
} from './download-types'

/** Default subdir-namer: replaces unsafe path characters in the artifactId. */
function sanitizeSubdir(s: string): string {
  return s.replace(/[/\\:*?"<>|]/g, '_')
}

/**
 * Remove `prefix` from the start of `filePath` if present, else return it
 * unchanged. Match is `\\`-and-`/`-tolerant so it doesn't matter whether the
 * manifest uses forward or back slashes; the prefix itself is taken verbatim.
 */
function stripPrefix(filePath: string, prefix: string | undefined): string {
  if (!prefix) return filePath
  // Normalise both sides to forward slashes for the comparison only.
  const norm = filePath.replace(/\\/g, '/')
  const pref = prefix.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '') + '/'
  if (norm.startsWith(pref)) return filePath.slice(pref.length)
  return filePath
}

/**
 * Compute the folder ReHoarder persists as a download's `destDir` — the path
 * the Downloads-tab "Open" button reveals.
 *
 * For a normal (wrapped) asset that's just `<vaultDir>/<subdir>`, the folder
 * holding `data/` and `cache/`. But plugin installs (engine-route /
 * project-install) write the manifest's file tree straight onto disk with no
 * `data/` wrapper, so `<vaultDir>/<subdir>` collapses onto the engine root (or
 * the project's `Plugins` parent) — too high. For those we walk the file list,
 * find the `.uplugin`, and return the folder that actually contains it. When a
 * plugin nests sub-plugins (each with their own `.uplugin`) we pick the
 * shallowest one, i.e. the plugin root.
 */
export function resolveReportedAssetDir(
  files: ReadonlyArray<{ filename: string }>,
  opts: { vaultDir: string; subdir: string; noWrapDataDir?: boolean; pathStripPrefix?: string }
): string {
  const subdir = opts.subdir === '' ? '' : sanitizeSubdir(opts.subdir)
  const baseDir = subdir === '' ? opts.vaultDir : path.join(opts.vaultDir, subdir)
  if (!opts.noWrapDataDir) return baseDir
  // No-wrap install: files land straight under `baseDir`. Anchor on the
  // shallowest `.uplugin` so "Open" reveals the plugin folder, not its parent.
  const upluginRel = files
    .filter((f) => /\.uplugin$/i.test(f.filename))
    .map((f) => stripPrefix(f.filename, opts.pathStripPrefix))
    .sort((a, b) => a.replace(/\\/g, '/').split('/').length - b.replace(/\\/g, '/').split('/').length)[0]
  if (!upluginRel) return baseDir
  return path.dirname(path.join(baseDir, upluginRel))
}

export interface AssetDownloadPlan {
  /** Manifest entries that will actually be assembled to disk, in manifest order. */
  filesToDownload: FileManifestEntry[]
  /** Sum of `fileSize` for the kept files only. */
  bytesTotal: number
  filesTotal: number
  /** Summaries for the entries that were filtered out by `skipPatterns`. */
  skippedSummaries: DownloadFileSummary[]
}

/**
 * Partition a manifest's files into "to download" and "to skip" given the
 * caller's `pathStripPrefix` + `skipPatterns`. The runner uses this BEFORE
 * starting work so it can persist accurate `bytesTotal` / `filesTotal` on the
 * download row; the orchestrator re-runs the same partition internally to
 * drive the assembly loop.
 */
export function planAssetDownload(
  manifest: Manifest,
  opts: Pick<DownloadOptions, 'pathStripPrefix' | 'skipPatterns'>
): AssetDownloadPlan {
  const skipRegexes = compilePatterns(opts.skipPatterns ?? [])
  const filesToDownload: FileManifestEntry[] = []
  const skippedSummaries: DownloadFileSummary[] = []
  for (const entry of manifest.files) {
    const relPath = stripPrefix(entry.filename, opts.pathStripPrefix)
    if (skipRegexes.length > 0 && matchesAny(relPath, skipRegexes)) {
      skippedSummaries.push({
        filename: entry.filename,
        fileSize: entry.fileSize,
        skipped: true
      })
      continue
    }
    filesToDownload.push(entry)
  }
  const bytesTotal = filesToDownload.reduce((acc, f) => acc + f.fileSize, 0)
  return {
    filesToDownload,
    bytesTotal,
    filesTotal: filesToDownload.length,
    skippedSummaries
  }
}

/**
 * One-line summary of the network side of a finished download, e.g.
 * `download stats: 812.4 MB in 41.2 s (19.7 MB/s), 790 chunks, avg fetch 310.2 ms, avg decode 6.1 ms`.
 * MB is decimal (10^6 bytes) and counts compressed bytes received from the
 * CDN; cache hits are excluded from the chunk count and the averages.
 */
export function formatDownloadStats(stats: ChunkSourceStats, durationMs: number): string {
  const mb = stats.bytesFetched / 1_000_000
  const seconds = durationMs / 1000
  const rate = seconds > 0 ? mb / seconds : 0
  const n = stats.chunksFetched
  const avgFetch = n > 0 ? stats.fetchMs / n : 0
  const avgDecode = n > 0 ? stats.decodeMs / n : 0
  return (
    `download stats: ${mb.toFixed(1)} MB in ${seconds.toFixed(1)} s (${rate.toFixed(1)} MB/s), ` +
    `${n} chunks, avg fetch ${avgFetch.toFixed(1)} ms, avg decode ${avgDecode.toFixed(1)} ms`
  )
}

/**
 * Download an entire Fab asset described by `bundle.manifest` into
 * `<vaultDir>/<assetSubdir>/data/`. Each chunk is fetched once.
 *
 * Files are assembled one at a time, in manifest order, while a
 * `ChunkPrefetcher` keeps up to `chunkConcurrency` chunk fetches (default
 * 16) running ahead of the assembler. Chunks needed by more than one stretch
 * of the plan are cached on disk under `<vaultDir>/<assetSubdir>/cache/`;
 * the rest stay in memory only until consumed. The cache directory is
 * removed when every file is verified.
 *
 * Files already on disk with the expected SHA1 are detected before any fetch
 * starts, so a resumed download doesn't pull their chunks again.
 */
export async function downloadAsset(
  bundle: ManifestBundle,
  opts: DownloadOptions & { fetchImpl: typeof fetch }
): Promise<DownloadResult> {
  if (bundle.manifest.meta.bIsFileData) {
    throw new Error('Cannot download a file-data manifest (bIsFileData=true) in v0c')
  }
  const startedAt = Date.now()
  const rawSubdir = opts.assetSubdir ?? bundle.locator.artifactId
  const subdir = rawSubdir === '' ? '' : sanitizeSubdir(rawSubdir)
  const assetDir = subdir === '' ? opts.vaultDir : path.join(opts.vaultDir, subdir)
  // `noWrapDataDir` writes files straight under `assetDir` instead of a `data/`
  // sub-folder. Engine / project plugin installs want the latter — the manifest's
  // file paths are already the layout the engine expects.
  const dataDir = opts.noWrapDataDir ? assetDir : path.join(assetDir, 'data')
  const cacheDir = path.join(assetDir, 'cache')
  await fsp.mkdir(dataDir, { recursive: true })
  await fsp.mkdir(cacheDir, { recursive: true })

  const source = new ChunkSource({
    fetchImpl: opts.fetchImpl,
    baseUri: bundle.baseUris[0],
    cacheDir,
    manifestFeatureLevel: bundle.manifest.meta.featureLevel,
    defaultHeaders: opts.chunkHeaders,
    queryString: bundle.chunkQueryStrings?.[0] ?? ''
  })

  // Plan first: bytesTotal / filesTotal must reflect only the files that will
  // actually be assembled, so the progress bar is honest about cruft skips.
  const plan = planAssetDownload(bundle.manifest, opts)
  const onLog = opts.onLog ?? (() => {})
  for (const s of plan.skippedSummaries) {
    onLog(`skip (cruft) ${s.filename} (${s.fileSize} bytes)`)
  }
  const { filesToDownload, bytesTotal, filesTotal } = plan
  let bytesDone = 0
  let bytesWritten = 0
  let filesDone = 0
  const summaries: DownloadFileSummary[] = [...plan.skippedSummaries]
  const onProgress = opts.onProgress
  const signal = opts.signal
  const throwIfCancelled = (): void => {
    if (signal?.aborted) throw new DownloadCancelledError()
  }

  // Resume support: find files that are already complete BEFORE scheduling
  // any fetch, so the prefetcher only pulls chunks that will be written.
  const destPathOf = (entry: FileManifestEntry): string =>
    path.join(dataDir, stripPrefix(entry.filename, opts.pathStripPrefix))
  const alreadyComplete = new Set<FileManifestEntry>()
  for (const entry of filesToDownload) {
    throwIfCancelled()
    if (await isFileAlreadyValid(destPathOf(entry), entry.sha1)) alreadyComplete.add(entry)
  }
  if (alreadyComplete.size > 0) {
    onLog(`resume: ${alreadyComplete.size}/${filesTotal} files already complete on disk`)
  }

  const progressStep = Math.max(1, opts.progressStepBytes ?? 4 * 1024 * 1024)
  const prefetcher = new ChunkPrefetcher(
    source,
    bundle.manifest.chunks,
    filesToDownload.filter((f) => !alreadyComplete.has(f)),
    { concurrency: normalizeChunkConcurrency(opts.chunkConcurrency), signal }
  )
  prefetcher.start()

  try {
    for (const entry of filesToDownload) {
      throwIfCancelled()
      const relPath = stripPrefix(entry.filename, opts.pathStripPrefix)
      const complete = alreadyComplete.has(entry)
      if (!complete) onLog(`assembling ${relPath} (${entry.fileSize} bytes)`)
      onProgress?.({
        bytesDone,
        bytesTotal,
        filesDone,
        filesTotal,
        currentFile: relPath
      })
      // In-file progress: large files would otherwise hold the bar still
      // until they complete, then jump.
      let inFile = 0
      let sinceEmit = 0
      const onBytes = (n: number): void => {
        inFile += n
        sinceEmit += n
        if (sinceEmit < progressStep) return
        sinceEmit = 0
        onProgress?.({
          bytesDone: bytesDone + inFile,
          bytesTotal,
          filesDone,
          filesTotal,
          currentFile: relPath
        })
      }
      const result = complete
        ? { skipped: true }
        : await assembleFile(entry, prefetcher, destPathOf(entry), {
            skipExistingCheck: true,
            onBytes
          })
      summaries.push({ filename: entry.filename, fileSize: entry.fileSize, skipped: result.skipped })
      if (!result.skipped) bytesWritten += entry.fileSize
      bytesDone += entry.fileSize
      filesDone += 1
      onProgress?.({
        bytesDone,
        bytesTotal,
        filesDone,
        filesTotal,
        currentFile: null
      })
    }
  } catch (err) {
    // Any failure observed after the user cancelled (a write interrupted,
    // a fetch torn down) is reported as the cancellation itself.
    if (signal?.aborted) throw new DownloadCancelledError()
    throw err
  } finally {
    prefetcher.stop()
  }

  await fsp.rm(cacheDir, { recursive: true, force: true })
  onLog(`download complete: ${filesDone}/${filesTotal} files, ${bytesWritten} bytes written`)
  onLog(formatDownloadStats(source.stats, Date.now() - startedAt))

  return {
    vaultDir: opts.vaultDir,
    dataDir,
    files: summaries,
    bytesWritten,
    durationMs: Date.now() - startedAt
  }
}
