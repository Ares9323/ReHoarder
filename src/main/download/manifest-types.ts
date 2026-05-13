/**
 * Typed shape of a parsed Epic Chunked Manifest, as produced by `parseManifest()`.
 * Field names match Unreal Engine's `FBuildPatchManifest`/`FFileManifest` source
 * naming where readable.
 *
 * See docs/superpowers/specs/2026-05-13-download-manager-v0.md §3 for the wire format.
 */

export interface ManifestMeta {
  /** EManifestVersion of the file (latest at time of writing: 18). */
  featureLevel: number
  /** When true, the build is a collection of file blobs rather than chunks. v0a rejects this. */
  bIsFileData: boolean
  appId: number
  appName: string
  buildVersion: string
  buildId: string
  launchExe: string
  launchCommand: string
  prereqIds: string[]
  prereqName: string
  prereqPath: string
  prereqArgs: string
  uninstallExe: string
  uninstallCommand: string
}

export interface ChunkInfo {
  /** 32-char hex uppercase GUID identifying the chunk. */
  guid: string
  /** Poly64 rolling hash as 16-char hex uppercase. */
  rollingHash: string
  /** SHA1 of the decompressed chunk data, 40-char hex uppercase. Empty string if absent. */
  sha1: string
  /** Data group 00-99, used to build the chunk URL subdirectory. */
  groupNumber: number
  /** Sliding-window size at chunk creation time (bytes). Informational. */
  windowSize: number
  /** Size of the `.chunk` file on the CDN (bytes). */
  fileSize: number
}

export interface ChunkPart {
  /** 32-char hex uppercase GUID of the chunk this part comes from. */
  chunkGuid: string
  /** Offset (bytes) into the decompressed chunk where this part begins. */
  offset: number
  /** Length (bytes) of this part. */
  size: number
}

export interface FileManifestEntry {
  /** Relative path inside the asset (e.g. `Engine/Plugins/Marketplace/Foo/Foo.uplugin`). */
  filename: string
  symlinkTarget: string
  /** SHA1 of the assembled file, 40-char hex uppercase. */
  sha1: string
  fileMetaFlags: number
  installTags: string[]
  chunkParts: ChunkPart[]
  /** Total file size in bytes (sum of chunkParts[].size). */
  fileSize: number
}

export interface Manifest {
  meta: ManifestMeta
  chunks: ChunkInfo[]
  files: FileManifestEntry[]
  customFields: Record<string, string>
}
