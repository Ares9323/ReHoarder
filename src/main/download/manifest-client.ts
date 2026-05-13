import { createHash } from 'node:crypto'
import { parseManifest } from './manifest-parser'
import { ManifestClientError } from './manifest-client-types'
import type {
  ManifestBundle,
  ManifestDistributionPoint,
  ManifestLocator,
  ManifestRequest
} from './manifest-client-types'

const CLOUD_DIR_SEGMENT = 'CloudDir'

/**
 * Returns the CDN base URI that precedes `CloudDir/`, including the trailing
 * `CloudDir/`. Used to build chunk URLs in v0c: `<base>/ChunksV4/<DG>/<...>.chunk`.
 *
 * Throws `ManifestClientError('clouddir-not-in-url')` when the URL does not
 * contain a `CloudDir` segment — that means the CDN is serving an unexpected
 * layout we don't support.
 */
export function extractCloudDirBase(url: string): string {
  return extractCloudDirInfo(url).baseUri
}

/**
 * Like {@link extractCloudDirBase} but also returns the query string of the
 * source manifest URL (including the leading `?`, or `''` if none). The Epic
 * CDN signs `manifestUrl` with time-limited query params; those same params
 * are required to access the chunks under the same `CloudDir/` tree, so the
 * chunk client appends this string to every chunk URL.
 */
export function extractCloudDirInfo(url: string): {
  baseUri: string
  queryString: string
} {
  const idx = url.indexOf(CLOUD_DIR_SEGMENT)
  if (idx < 0) {
    throw new ManifestClientError(
      'clouddir-not-in-url',
      `Manifest URL has no "${CLOUD_DIR_SEGMENT}" segment: ${url}`
    )
  }
  const baseUri = url.slice(0, idx + CLOUD_DIR_SEGMENT.length + 1) // include trailing slash
  const queryIdx = url.indexOf('?')
  const queryString = queryIdx > 0 ? url.slice(queryIdx) : ''
  return { baseUri, queryString }
}

interface RawDistributionPoint {
  manifestUrl?: string
  uri?: string
  queryParams?: Array<{ name: string; value: string }>
}

interface RawDownloadInfoEntry {
  artifactId?: string
  manifestHash?: string
  distributionPoints?: RawDistributionPoint[]
}

interface RawFabResponse {
  downloadInfo?: RawDownloadInfoEntry[]
}

function buildFormBody(req: ManifestRequest, platform: 'Windows' | 'Mac'): string {
  const params = new URLSearchParams()
  params.set('item_id', req.itemId)
  params.set('namespace', req.namespace)
  params.set('platform', platform)
  return params.toString()
}

function normalizeDistributionPoint(raw: RawDistributionPoint): ManifestDistributionPoint | null {
  if (raw.manifestUrl) return { url: raw.manifestUrl }
  if (raw.uri) {
    const query = (raw.queryParams ?? [])
      .map((q) => `${q.name}=${q.value}`)
      .join('&')
    const url = query.length > 0 ? `${raw.uri}?${query}` : raw.uri
    return { url }
  }
  return null
}

async function postManifestOnce(
  fetchImpl: typeof fetch,
  req: ManifestRequest,
  platform: 'Windows' | 'Mac'
): Promise<Response> {
  const url = `https://www.fab.com/e/artifacts/${req.artifactId}/manifest`
  return await fetchImpl(url, {
    method: 'POST',
    headers: {
      Authorization: `bearer ${req.accessToken}`,
      'content-type': 'application/x-www-form-urlencoded'
    },
    body: buildFormBody(req, platform)
  })
}

/**
 * POST `/e/artifacts/{artifactId}/manifest` to Fab and return the parsed
 * `ManifestLocator`. If `platform === 'Mac'` and the call returns non-2xx,
 * transparently retry with `platform = 'Windows'` (Fab serves Windows
 * builds even for Mac requests in this case).
 */
export async function fetchManifestLocator(
  fetchImpl: typeof fetch,
  req: ManifestRequest
): Promise<ManifestLocator> {
  let response = await postManifestOnce(fetchImpl, req, req.platform)
  if (!response.ok && req.platform === 'Mac') {
    response = await postManifestOnce(fetchImpl, req, 'Windows')
  }
  if (!response.ok) {
    throw new ManifestClientError(
      'fab-non-2xx',
      `Fab /e/artifacts/.../manifest returned ${response.status}`
    )
  }

  let raw: RawFabResponse
  try {
    raw = (await response.json()) as RawFabResponse
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new ManifestClientError(
      'fab-bad-json',
      `Fab manifest response was not valid JSON: ${msg}`
    )
  }

  const first = raw.downloadInfo?.[0]
  if (!first || !first.distributionPoints || first.distributionPoints.length === 0) {
    throw new ManifestClientError(
      'fab-no-distribution-points',
      'Fab manifest response had no downloadInfo[0].distributionPoints'
    )
  }
  const normalized = first.distributionPoints
    .map(normalizeDistributionPoint)
    .filter((p): p is ManifestDistributionPoint => p !== null)
  if (normalized.length === 0) {
    throw new ManifestClientError(
      'fab-no-distribution-points',
      'Fab manifest response distributionPoints had no usable manifestUrl or uri'
    )
  }
  return {
    artifactId: first.artifactId ?? req.artifactId,
    manifestHash: (first.manifestHash ?? '').toUpperCase(),
    distributionPoints: normalized
  }
}

/**
 * Try each distribution point in order until one returns a 2xx blob whose
 * SHA1 hex matches `locator.manifestHash`. Non-2xx, network errors, and
 * hash mismatches all cause the loop to continue to the next point. Throws
 * `ManifestClientError('cdn-all-failed')` if every point fails.
 */
export async function downloadManifestBlob(
  fetchImpl: typeof fetch,
  locator: ManifestLocator
): Promise<Buffer> {
  const errors: string[] = []
  for (const point of locator.distributionPoints) {
    try {
      const response = await fetchImpl(point.url, { method: 'GET' })
      if (!response.ok) {
        errors.push(`${point.url}: HTTP ${response.status}`)
        continue
      }
      const buf = Buffer.from(await response.arrayBuffer())
      const actual = createHash('sha1').update(buf).digest('hex').toUpperCase()
      if (actual !== locator.manifestHash) {
        errors.push(`${point.url}: hash mismatch (got ${actual})`)
        continue
      }
      return buf
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      errors.push(`${point.url}: ${msg}`)
    }
  }
  throw new ManifestClientError(
    'cdn-all-failed',
    `All ${locator.distributionPoints.length} distribution points failed; expected SHA1 ${locator.manifestHash}. Errors:\n  ${errors.join('\n  ')}`
  )
}

/**
 * Top-level entry point: take a `ManifestRequest`, hit Fab + CDN, parse the
 * binary manifest, and return a `ManifestBundle` ready for the v0c chunk
 * client. Caller is responsible for providing a `fetchImpl` that can talk
 * to fab.com (Cloudflare-blessed) — in production that's the Electron
 * `net.fetch` wrapper on the CF-warmup partition.
 */
export async function requestManifest(
  fetchImpl: typeof fetch,
  req: ManifestRequest
): Promise<ManifestBundle> {
  const locator = await fetchManifestLocator(fetchImpl, req)
  const blob = await downloadManifestBlob(fetchImpl, locator)
  const manifest = parseManifest(blob)
  const infos = locator.distributionPoints.map((p) => extractCloudDirInfo(p.url))
  const baseUris = infos.map((i) => i.baseUri)
  const chunkQueryStrings = infos.map((i) => i.queryString)
  return { manifest, baseUris, chunkQueryStrings, locator }
}
