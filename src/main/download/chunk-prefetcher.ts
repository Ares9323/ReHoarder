import type { ChunkSource } from './chunk-source'
import type { ChunkProvider } from './file-assembler'
import type { ChunkInfo, FileManifestEntry } from './manifest-types'
import { DownloadCancelledError } from './download-types'

export const DEFAULT_CHUNK_CONCURRENCY = 16
export const MIN_CHUNK_CONCURRENCY = 1
export const MAX_CHUNK_CONCURRENCY = 64

/** Clamp an untrusted concurrency value into `[1, 64]`, falling back to the default. */
export function normalizeChunkConcurrency(n: number | undefined): number {
  if (n === undefined || !Number.isFinite(n)) return DEFAULT_CHUNK_CONCURRENCY
  return Math.max(MIN_CHUNK_CONCURRENCY, Math.min(MAX_CHUNK_CONCURRENCY, Math.trunc(n)))
}

export interface ChunkPrefetcherOptions {
  /** Max `source.get` calls in flight at once. */
  concurrency: number
  /**
   * Max chunks scheduled ahead of the assembler (in flight + resolved but not
   * yet consumed). Bounds memory to roughly `window` decoded chunks.
   * Default `2 * concurrency`.
   */
  window?: number
  /** When fired, no new fetch is scheduled and pending `get()` calls reject with `DownloadCancelledError`. */
  signal?: AbortSignal
}

/**
 * Reject with `DownloadCancelledError` as soon as `signal` fires, without
 * waiting for `p`. `p` keeps a handler attached either way, so a late
 * rejection never surfaces as unhandled.
 */
function raceAbort<T>(p: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return p
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) {
      p.catch(() => {})
      reject(new DownloadCancelledError())
      return
    }
    const onAbort = (): void => reject(new DownloadCancelledError())
    signal.addEventListener('abort', onAbort, { once: true })
    p.then(
      (v) => {
        signal.removeEventListener('abort', onAbort)
        resolve(v)
      },
      (err) => {
        signal.removeEventListener('abort', onAbort)
        reject(err)
      }
    )
  })
}

/**
 * Parallel read-ahead in front of `ChunkSource` for one download plan.
 *
 * The assembler stays sequential: it asks for chunk parts in manifest order,
 * one at a time. This class knows that order up front (from the files that
 * will actually be assembled), so it keeps up to `concurrency` fetches
 * running ahead of the assembler, never more than `window` chunks past the
 * one currently being consumed. By the time the assembler reaches a part,
 * its chunk is usually already decoded.
 *
 * Memory policy:
 *   - A chunk used by a single contiguous run of parts (the common case) is
 *     fetched with `persist: false`. It lives only in the read-ahead map and
 *     is dropped the moment the assembler takes it (plus the one-entry
 *     `last` memo that serves back-to-back parts of the same chunk).
 *   - A chunk needed again after other chunks intervene (shared between
 *     files, or split within a file) is persisted to the disk cache on first
 *     fetch; later runs re-read it through `ChunkSource`'s validated cache
 *     path instead of pinning it in RAM.
 */
export class ChunkPrefetcher implements ChunkProvider {
  private readonly byGuid = new Map<string, ChunkInfo>()
  /** Unique GUIDs in the order the assembler will first ask for them. */
  private readonly order: string[] = []
  /** GUIDs needed by more than one run of parts: written to the disk cache. */
  private readonly shared = new Set<string>()
  /** Scheduled but not yet taken by the assembler. */
  private readonly ahead = new Map<string, Promise<Buffer>>()
  /** GUIDs the assembler has already taken once. */
  private readonly taken = new Set<string>()
  private readonly concurrency: number
  private readonly window: number
  private readonly signal: AbortSignal | undefined
  private readonly onAbort = (): void => this.stop()
  private nextIndex = 0
  private takenCount = 0
  private inFlight = 0
  private stopped = false
  private last: { guid: string; buf: Buffer } | null = null

  constructor(
    private readonly source: Pick<ChunkSource, 'get'>,
    chunks: ReadonlyArray<ChunkInfo>,
    files: ReadonlyArray<FileManifestEntry>,
    opts: ChunkPrefetcherOptions
  ) {
    for (const c of chunks) this.byGuid.set(c.guid.toUpperCase(), c)
    const runs = new Map<string, number>()
    let prev = ''
    for (const f of files) {
      for (const part of f.chunkParts) {
        const guid = part.chunkGuid.toUpperCase()
        if (guid === prev) continue
        prev = guid
        const n = (runs.get(guid) ?? 0) + 1
        runs.set(guid, n)
        if (n === 1) {
          // Unknown GUIDs are left out of the read-ahead; `get()` reports them
          // when the assembler actually reaches the part.
          if (this.byGuid.has(guid)) this.order.push(guid)
        } else {
          this.shared.add(guid)
        }
      }
    }
    this.concurrency = Math.max(1, Math.trunc(opts.concurrency))
    this.window = Math.max(this.concurrency, Math.trunc(opts.window ?? 2 * this.concurrency))
    this.signal = opts.signal
    this.signal?.addEventListener('abort', this.onAbort, { once: true })
  }

  /** Kick off the first batch of fetches. */
  start(): void {
    this.pump()
  }

  /**
   * Stop scheduling and drop every buffered chunk. Fetches already in flight
   * finish on their own; their results (or errors) are discarded.
   */
  stop(): void {
    this.stopped = true
    this.ahead.clear()
    this.last = null
    this.signal?.removeEventListener('abort', this.onAbort)
  }

  async get(part: { guid: string }): Promise<Buffer> {
    if (this.signal?.aborted) throw new DownloadCancelledError()
    const guid = part.guid.toUpperCase()
    if (this.last?.guid === guid) return this.last.buf
    const info = this.byGuid.get(guid)
    if (!info) throw new Error(`ChunkInfo missing for guid=${part.guid}`)

    let pending: Promise<Buffer>
    if (!this.taken.has(guid)) {
      this.taken.add(guid)
      this.takenCount += 1
      // Normally already scheduled. The fallback only runs if the assembler
      // asks out of plan order, or after `stop()`.
      pending =
        this.ahead.get(guid) ?? this.source.get(info, { persist: this.shared.has(guid) })
      this.ahead.delete(guid)
      this.pump()
    } else {
      // A later run of a shared chunk: served from the disk cache.
      pending = this.source.get(info, { persist: true })
    }
    // Release the previous chunk before waiting so at most one extra buffer
    // is pinned outside the read-ahead window.
    this.last = null
    const buf = await raceAbort(pending, this.signal)
    this.last = { guid, buf }
    return buf
  }

  private pump(): void {
    while (
      !this.stopped &&
      this.inFlight < this.concurrency &&
      this.nextIndex < this.order.length &&
      this.nextIndex < this.takenCount + this.window
    ) {
      const guid = this.order[this.nextIndex++]
      if (this.taken.has(guid)) continue
      this.schedule(guid)
    }
  }

  private schedule(guid: string): void {
    const info = this.byGuid.get(guid)!
    this.inFlight += 1
    const p = this.source.get(info, { persist: this.shared.has(guid) })
    const settle = (): void => {
      this.inFlight -= 1
      this.pump()
    }
    // Two-argument `then` handles the rejection here, so a chunk that fails
    // after `stop()` (never consumed) can't become an unhandled rejection.
    // The assembler still sees the error through the original promise.
    p.then(settle, settle)
    this.ahead.set(guid, p)
  }
}
