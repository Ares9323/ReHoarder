import { promises as fsp } from 'node:fs'
import * as path from 'node:path'
import { ChunkSource } from './chunk-source'
import { assembleFile, type ChunkProvider } from './file-assembler'
import { compilePatterns, matchesAny } from './cruft-filter'
import type { ManifestBundle } from './manifest-client-types'
import type { ChunkInfo, FileManifestEntry, Manifest } from './manifest-types'
import type {
  DownloadOptions,
  DownloadResult,
  DownloadFileSummary
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
 * Bridges the assembler (which has only `chunkGuid` on each `ChunkPart`) and
 * the `ChunkSource` (which needs the full `ChunkInfo` with rollingHash + sha1
 * to validate cache hits). The orchestrator owns this map; the assembler
 * sees a uniform `ChunkProvider` interface.
 */
function buildChunkResolver(
  source: ChunkSource,
  chunks: ChunkInfo[]
): ChunkProvider & { resolveByGuid(guid: string): ChunkInfo } {
  const byGuid = new Map<string, ChunkInfo>()
  for (const c of chunks) byGuid.set(c.guid.toUpperCase(), c)
  return {
    resolveByGuid(guid: string): ChunkInfo {
      const info = byGuid.get(guid.toUpperCase())
      if (!info) throw new Error(`ChunkInfo missing for guid=${guid}`)
      return info
    },
    async get(part: { guid: string }): Promise<Buffer> {
      const info = byGuid.get(part.guid.toUpperCase())
      if (!info) throw new Error(`ChunkInfo missing for guid=${part.guid}`)
      return await source.get(info)
    }
  }
}

/**
 * Download an entire Fab asset described by `bundle.manifest` into
 * `<vaultDir>/<assetSubdir>/data/`. Chunks are fetched once each and cached
 * on disk under `<vaultDir>/<assetSubdir>/cache/` while the download runs;
 * the cache directory is removed when every file is verified.
 *
 * In v0c this is **sequential**: one file at a time, chunks within a file
 * are pulled in order. v0c+ will introduce parallelism.
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
  const provider = buildChunkResolver(source, bundle.manifest.chunks)

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

  for (const entry of filesToDownload) {
    opts.signal?.throwIfAborted()
    const relPath = stripPrefix(entry.filename, opts.pathStripPrefix)
    onLog(`assembling ${relPath} (${entry.fileSize} bytes)`)
    onProgress?.({
      bytesDone,
      bytesTotal,
      filesDone,
      filesTotal,
      currentFile: relPath
    })
    const destPath = path.join(dataDir, relPath)
    const result = await assembleFile(entry, provider, destPath)
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

  await fsp.rm(cacheDir, { recursive: true, force: true })
  onLog(`download complete: ${filesDone}/${filesTotal} files, ${bytesWritten} bytes written`)

  return {
    vaultDir: opts.vaultDir,
    dataDir,
    files: summaries,
    bytesWritten,
    durationMs: Date.now() - startedAt
  }
}
