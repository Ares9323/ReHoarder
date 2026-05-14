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
  /** Headers sent on every chunk GET. Use this to pass `Authorization: bearer …` and a Launcher-style `User-Agent` (the Epic CDN requires both for chunk fetches). */
  chunkHeaders?: Record<string, string>
  /**
   * Strip this prefix from every file path in the manifest before writing.
   * Plugin manifests ship engine-relative paths like
   * `Engine/Plugins/Marketplace/MyPlugin/MyPlugin.uplugin`; when installing into
   * a project's `Plugins/` we want the file to land at `MyPlugin/MyPlugin.uplugin`
   * instead, so the stripper removes that prefix per-entry. Paths that don't
   * start with the prefix are written unchanged.
   */
  pathStripPrefix?: string
  /**
   * When `true`, write files directly under `<vaultDir>/<assetSubdir>/`
   * instead of `<vaultDir>/<assetSubdir>/data/`. The wrapping is useful for
   * vault-style downloads (cache + data side-by-side), but actively wrong
   * for engine/project installs where the file tree is already its own
   * containment unit.
   */
  noWrapDataDir?: boolean
  /**
   * Glob patterns (cruft-filter syntax) for files that must NOT be written
   * to disk. Files matching any pattern are reported in the result with
   * `skipped: true` but don't count toward `bytesTotal` / `filesTotal`, so
   * progress reflects only files that will actually be assembled.
   */
  skipPatterns?: string[]
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
