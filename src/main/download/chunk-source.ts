import { promises as fsp, existsSync } from 'node:fs'
import * as path from 'node:path'
import { createHash } from 'node:crypto'
import { decodeChunk } from './chunk-decoder'
import { poly64Hash } from './rolling-hash'
import type { ChunkInfo } from './manifest-types'

export interface ChunkSourceOptions {
  fetchImpl: typeof fetch
  /** A `<cdn>/.../CloudDir/`-style URL with trailing slash. */
  baseUri: string
  /** Directory where decoded chunks are persisted between calls. Created on demand. */
  cacheDir: string
  /** `manifest.meta.featureLevel` — picks the chunk subdir (`Chunks` / `V2` / `V3` / `V4`). */
  manifestFeatureLevel: number
  /** Optional headers sent on every chunk GET. The Epic CDN (`download.epicgames.com`)
   * gates chunk access behind `Authorization: bearer <accessToken>` + a Launcher-style
   * User-Agent in recent Fab releases; without them every chunk returns HTTP 403. */
  defaultHeaders?: Record<string, string>
  /**
   * Query string (including the leading `?`, or `''`) appended to every
   * chunk URL. Matches whatever was attached to the source `manifestUrl`
   * — the Epic CDN signs the whole `CloudDir/` tree with the same token,
   * so chunks 403 unless the same signature is replayed.
   */
  queryString?: string
}

function chunkSubdir(featureLevel: number): string {
  if (featureLevel < 3) return 'Chunks'
  if (featureLevel < 6) return 'ChunksV2'
  if (featureLevel < 15) return 'ChunksV3'
  return 'ChunksV4'
}

function buildChunkFilename(chunk: ChunkInfo): string {
  return `${chunk.rollingHash}_${chunk.guid}.chunk`
}

function buildChunkUrl(opts: ChunkSourceOptions, chunk: ChunkInfo): string {
  const dg2 = String(chunk.groupNumber).padStart(2, '0')
  const path = `${opts.baseUri}${chunkSubdir(opts.manifestFeatureLevel)}/${dg2}/${buildChunkFilename(chunk)}`
  return path + (opts.queryString ?? '')
}

/**
 * Per-asset chunk reader. Combines:
 *   1. A persistent on-disk cache of *decoded* chunk payloads keyed by the
 *      chunk's filename (`<rollingHash>_<guid>.chunk`). Cache hits validate
 *      the cached payload against the manifest's Poly64 + SHA1; corrupt
 *      cache entries are silently re-fetched.
 *   2. An in-memory dedup of in-flight URL fetches. If two callers request
 *      the same chunk concurrently, the second awaits the first's result.
 *
 * The cache directory typically lives at `<vault>/<assetId>/cache/`. It's
 * the caller's responsibility to clean it up after a successful download
 * (the orchestrator does this in v0c).
 */
export class ChunkSource {
  private readonly inFlight = new Map<string, Promise<Buffer>>()

  constructor(private readonly opts: ChunkSourceOptions) {}

  get(chunk: ChunkInfo): Promise<Buffer> {
    const url = buildChunkUrl(this.opts, chunk)
    let pending = this.inFlight.get(url)
    if (!pending) {
      const filename = buildChunkFilename(chunk)
      const cachePath = path.join(this.opts.cacheDir, filename)
      // Fast synchronous check: if the cache file doesn't exist, skip async
      // validation entirely so the fetch starts before the next event-loop tick.
      if (existsSync(cachePath)) {
        pending = this.tryReadCache(cachePath, chunk).then((cached) => {
          if (cached) return cached
          return this.fetchDecodeAndCache(url, chunk, cachePath)
        }).finally(() => {
          this.inFlight.delete(url)
        })
      } else {
        pending = this.fetchDecodeAndCache(url, chunk, cachePath).finally(() => {
          this.inFlight.delete(url)
        })
      }
      this.inFlight.set(url, pending)
    }
    return pending
  }

  private async tryReadCache(cachePath: string, chunk: ChunkInfo): Promise<Buffer | null> {
    if (!existsSync(cachePath)) return null
    let buf: Buffer
    try {
      buf = await fsp.readFile(cachePath)
    } catch {
      return null
    }
    const actualPoly = poly64Hash(buf).toString(16).toUpperCase().padStart(16, '0')
    if (actualPoly !== chunk.rollingHash.toUpperCase()) return null
    if (chunk.sha1 && chunk.sha1 !== '0'.repeat(40)) {
      const actualSha = createHash('sha1').update(buf).digest('hex').toUpperCase()
      if (actualSha !== chunk.sha1.toUpperCase()) return null
    }
    return buf
  }

  private async fetchDecodeAndCache(
    url: string,
    chunk: ChunkInfo,
    cachePath: string
  ): Promise<Buffer> {
    const response = await this.opts.fetchImpl(url, {
      method: 'GET',
      headers: this.opts.defaultHeaders
    })
    if (!response.ok) {
      throw new Error(`Chunk ${chunk.guid} fetch returned ${response.status} (${url})`)
    }
    const raw = Buffer.from(await response.arrayBuffer())
    const payload = decodeChunk(raw, {
      guid: chunk.guid,
      rollingHash: chunk.rollingHash,
      sha1: chunk.sha1
    })
    await fsp.mkdir(path.dirname(cachePath), { recursive: true })
    await fsp.writeFile(cachePath, payload)
    return payload
  }
}
