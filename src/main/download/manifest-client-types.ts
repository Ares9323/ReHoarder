import type { Manifest } from './manifest-types'

/**
 * Caller-provided context for resolving a Fab manifest. The caller already
 * obtained these IDs from the Fab library API or DB:
 *
 *   - `artifactId`: the `projectVersions[i].artifactId` (= "AppName/BuildId").
 *   - `itemId`:     the Fab asset id (uppercase hex), used as `item_id`.
 *   - `namespace`:  the Fab `assetNamespace`.
 *   - `platform`:   "Windows" | "Mac". If the first call to Fab returns
 *                   non-2xx on Mac, the client transparently retries with
 *                   Windows.
 *   - `accessToken`: bearer token for Fab; reused from the existing OAuth
 *                    session managed by `src/main/auth/session.ts`.
 */
export interface ManifestRequest {
  artifactId: string
  itemId: string
  namespace: string
  platform: 'Windows' | 'Mac'
  accessToken: string
}

/**
 * One distribution point — a CDN endpoint hosting both the manifest blob
 * and (later, in v0c) the chunk blobs. Normalized: `url` is a fully formed
 * GET URL that includes any required query string.
 */
export interface ManifestDistributionPoint {
  url: string
}

/**
 * The Fab POST `/e/artifacts/{artifactId}/manifest` response, parsed into a
 * normalized shape. `manifestHash` is SHA1 hex uppercase of the binary blob
 * served from any of the distribution points.
 */
export interface ManifestLocator {
  artifactId: string
  manifestHash: string
  distributionPoints: ManifestDistributionPoint[]
}

/**
 * Final output of `requestManifest`: the parsed manifest plus the array of
 * CDN base URIs (e.g. `https://cdn/.../CloudDir/`) that the chunk client
 * (v0c) will use to build chunk URLs. Each base is the corresponding entry
 * in `locator.distributionPoints` truncated at the `CloudDir/` boundary.
 */
export interface ManifestBundle {
  manifest: Manifest
  baseUris: string[]
  /**
   * One entry per distribution point: the query string of the source
   * `manifestUrl` (including the leading `?`, or `''` if none). The chunk
   * client appends this to every chunk URL it builds, because the Epic CDN
   * signs the whole `CloudDir/` tree with the same time-limited token.
   */
  chunkQueryStrings: string[]
  locator: ManifestLocator
}

/** Error codes thrown by the manifest client. */
export type ManifestClientErrorCode =
  | 'fab-non-2xx'
  | 'fab-bad-json'
  | 'fab-no-distribution-points'
  | 'cdn-all-failed'
  | 'cdn-hash-mismatch'
  | 'clouddir-not-in-url'

export class ManifestClientError extends Error {
  constructor(
    readonly code: ManifestClientErrorCode,
    message: string
  ) {
    super(message)
    this.name = 'ManifestClientError'
  }
}
