import type { Manifest, FileManifestEntry } from './manifest-types'
import type { ManifestBundle } from './manifest-client-types'

/** Caller-supplied configuration for a single asset download. */
export interface DownloadOptions {
  /** Root vault directory. The actual asset goes in `<vaultDir>/<artifactId>/data/`. */
  vaultDir: string
  /** Used as the immediate subdirectory under `vaultDir`. Default: `bundle.locator.artifactId` (with slashes replaced by `_`). */
  assetSubdir?: string
  /** When provided, called with cumulative progress as each chunk completes. */
  onProgress?: (p: DownloadProgress) => void
  /** When provided, called with one human-readable line per significant step. */
  onLog?: (line: string) => void
  /** AbortSignal — when fired, in-progress chunk downloads finish their HTTP call but no new chunks are started; throws `DownloadCancelledError` from `downloadAsset`. */
  signal?: AbortSignal
}

export interface DownloadProgress {
  /** Bytes successfully assembled across all completed files so far. */
  bytesDone: number
  /** Sum of `entry.fileSize` across every file in the manifest (subject to skip filters; in v0c always all files). */
  bytesTotal: number
  /** Number of files fully written and SHA1-verified so far. */
  filesDone: number
  /** Number of files in the plan. */
  filesTotal: number
  /** The file currently being assembled, or `null` between files / at the end. */
  currentFile: string | null
}

export interface DownloadFileSummary {
  filename: string
  fileSize: number
  /** True if the file already existed on disk with matching SHA1 and was skipped. */
  skipped: boolean
}

export interface DownloadResult {
  vaultDir: string
  /** Absolute path of `<vaultDir>/<assetSubdir>/data/`. */
  dataDir: string
  files: DownloadFileSummary[]
  /** Sum of `entry.fileSize` for files written this run (NOT including skipped files). */
  bytesWritten: number
  /** Wall-clock duration in milliseconds. */
  durationMs: number
}

export class DownloadCancelledError extends Error {
  constructor(message = 'Download cancelled') {
    super(message)
    this.name = 'DownloadCancelledError'
  }
}

/**
 * Re-exported aliases so callers don't have to import from three different
 * modules for the common types. Keeps the public surface of the `download/`
 * directory ergonomic.
 */
export type { Manifest, FileManifestEntry, ManifestBundle }
