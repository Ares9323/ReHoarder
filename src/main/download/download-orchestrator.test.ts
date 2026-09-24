import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { promises as fsp, existsSync } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { deflateSync } from 'node:zlib'
import { createHash } from 'node:crypto'
import { downloadAsset } from './download-orchestrator'
import { CHUNK_MAGIC } from './chunk-decoder'
import { poly64Hash } from './rolling-hash'
import {
  bytes,
  guidHex,
  uint32le,
  uint64le,
  uint8
} from './test-fixtures'
import type { Manifest } from './manifest-types'
import type { ManifestBundle } from './manifest-client-types'
import { DownloadCancelledError } from './download-types'

const GUID_A = 'A0000000000000000000000000000000'
const GUID_B = 'B0000000000000000000000000000000'
const PAYLOAD_A = Buffer.from('first chunk payload bytes_______') // 32 bytes
const PAYLOAD_B = Buffer.from('second chunk payload bytes______') // 32 bytes

function sha1Upper(buf: Buffer): string {
  return createHash('sha1').update(buf).digest('hex').toUpperCase()
}

function buildChunkBlob(guidHex32: string, payload: Buffer): Buffer {
  const rolling = poly64Hash(payload)
  const sha = createHash('sha1').update(payload).digest()
  const stored = deflateSync(payload)
  return bytes(
    uint32le(CHUNK_MAGIC),
    uint32le(3),
    uint32le(66),
    uint32le(stored.length),
    guidHex(guidHex32),
    uint64le(rolling),
    uint8(0x01),
    sha,
    uint8(0x03),
    uint32le(payload.length),
    stored
  )
}

function chunkInfo(guidHex32: string, payload: Buffer, groupNumber: number) {
  return {
    guid: guidHex32,
    rollingHash: poly64Hash(payload).toString(16).toUpperCase().padStart(16, '0'),
    sha1: sha1Upper(payload),
    groupNumber,
    windowSize: 1024,
    fileSize: deflateSync(payload).length + 66
  }
}

function buildManifest(): Manifest {
  const cA = chunkInfo(GUID_A, PAYLOAD_A, 3)
  const cB = chunkInfo(GUID_B, PAYLOAD_B, 7)
  const fileBytes = Buffer.concat([PAYLOAD_A, PAYLOAD_B])
  return {
    meta: {
      featureLevel: 18,
      bIsFileData: false,
      appId: 1,
      appName: 'TestAsset',
      buildVersion: '1.0.0',
      buildId: 'b1',
      launchExe: '',
      launchCommand: '',
      prereqIds: [],
      prereqName: '',
      prereqPath: '',
      prereqArgs: '',
      uninstallExe: '',
      uninstallCommand: ''
    },
    chunks: [cA, cB],
    files: [
      {
        filename: 'Content/MyAsset.uasset',
        symlinkTarget: '',
        sha1: sha1Upper(fileBytes),
        fileMetaFlags: 0,
        installTags: [],
        chunkParts: [
          { chunkGuid: GUID_A, offset: 0, size: 32 },
          { chunkGuid: GUID_B, offset: 0, size: 32 }
        ],
        fileSize: 64
      },
      {
        filename: 'Engine/Plugins/Tiny.txt',
        symlinkTarget: '',
        sha1: sha1Upper(PAYLOAD_A.subarray(0, 5)),
        fileMetaFlags: 0,
        installTags: [],
        chunkParts: [{ chunkGuid: GUID_A, offset: 0, size: 5 }],
        fileSize: 5
      }
    ],
    customFields: {}
  }
}

function buildBundle(manifest: Manifest): ManifestBundle {
  return {
    manifest,
    baseUris: ['https://cdn.example/foo/CloudDir/'],
    chunkQueryStrings: [''],
    locator: {
      artifactId: 'TestAsset/build-1',
      manifestHash: '0'.repeat(40),
      distributionPoints: [{ url: 'https://cdn.example/foo/CloudDir/x.manifest' }]
    }
  }
}

let tmpVault: string

beforeEach(async () => {
  tmpVault = await fsp.mkdtemp(path.join(os.tmpdir(), 'rh-orch-'))
})

afterEach(async () => {
  await fsp.rm(tmpVault, { recursive: true, force: true })
})

describe('downloadAsset', () => {
  it('downloads every chunk once and assembles all files under <vault>/<id>/data/', async () => {
    const manifest = buildManifest()
    const bundle = buildBundle(manifest)
    const blobA = buildChunkBlob(GUID_A, PAYLOAD_A)
    const blobB = buildChunkBlob(GUID_B, PAYLOAD_B)
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.includes(GUID_A)) return Promise.resolve(new Response(blobA, { status: 200 }))
      if (url.includes(GUID_B)) return Promise.resolve(new Response(blobB, { status: 200 }))
      return Promise.resolve(new Response('not found', { status: 404 }))
    })

    const result = await downloadAsset(bundle, {
      vaultDir: tmpVault,
      fetchImpl: fetchMock as unknown as typeof fetch
    })

    expect(result.files).toHaveLength(2)
    expect(result.files.every((f) => !f.skipped)).toBe(true)
    expect(result.bytesWritten).toBe(64 + 5)

    const safeArtifact = 'TestAsset_build-1' // slashes replaced
    const dataDir = path.join(tmpVault, safeArtifact, 'data')
    expect(result.dataDir).toBe(dataDir)
    expect(existsSync(path.join(dataDir, 'Content/MyAsset.uasset'))).toBe(true)
    expect(existsSync(path.join(dataDir, 'Engine/Plugins/Tiny.txt'))).toBe(true)

    // Chunks A and B fetched exactly once each (even though file 1 uses both
    // and file 2 reuses A).
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('reports progress callbacks with cumulative bytes', async () => {
    const manifest = buildManifest()
    const bundle = buildBundle(manifest)
    const blobA = buildChunkBlob(GUID_A, PAYLOAD_A)
    const blobB = buildChunkBlob(GUID_B, PAYLOAD_B)
    const fetchMock = vi.fn().mockImplementation((url: string) =>
      Promise.resolve(new Response(url.includes(GUID_A) ? blobA : blobB, { status: 200 }))
    )
    const progress: number[] = []

    await downloadAsset(bundle, {
      vaultDir: tmpVault,
      fetchImpl: fetchMock as unknown as typeof fetch,
      onProgress: (p) => progress.push(p.bytesDone)
    })

    expect(progress.length).toBeGreaterThan(0)
    // Final progress matches total.
    expect(progress[progress.length - 1]).toBe(64 + 5)
    // Monotonically non-decreasing.
    for (let i = 1; i < progress.length; i++) {
      expect(progress[i]).toBeGreaterThanOrEqual(progress[i - 1])
    }
  })

  it('removes the cache directory after a successful run', async () => {
    const manifest = buildManifest()
    const bundle = buildBundle(manifest)
    const blobA = buildChunkBlob(GUID_A, PAYLOAD_A)
    const blobB = buildChunkBlob(GUID_B, PAYLOAD_B)
    const fetchMock = vi.fn().mockImplementation((url: string) =>
      Promise.resolve(new Response(url.includes(GUID_A) ? blobA : blobB, { status: 200 }))
    )

    const result = await downloadAsset(bundle, {
      vaultDir: tmpVault,
      fetchImpl: fetchMock as unknown as typeof fetch
    })
    const cacheDir = path.join(path.dirname(result.dataDir), 'cache')
    expect(existsSync(cacheDir)).toBe(false)
  })

  it('rejects the call when the manifest declares bIsFileData=true', async () => {
    const manifest = buildManifest()
    manifest.meta.bIsFileData = true
    const bundle = buildBundle(manifest)
    await expect(
      downloadAsset(bundle, {
        vaultDir: tmpVault,
        fetchImpl: vi.fn() as unknown as typeof fetch
      })
    ).rejects.toThrow(/file-data/i)
  })
})

// ---------------------------------------------------------------------------
// Parallel prefetch pipeline
// ---------------------------------------------------------------------------

function manyGuid(i: number): string {
  return 'C' + i.toString(16).toUpperCase().padStart(31, '0')
}

function manyPayload(i: number): Buffer {
  return Buffer.from(`chunk #${i} `.repeat(8).padEnd(96, '.'))
}

/**
 * Build a manifest with `chunkCount` distinct chunks spread over files of
 * `chunksPerFile` chunks each (in order). Returns the manifest plus the
 * wire blobs keyed by GUID and the expected bytes of every file.
 */
function buildManyChunkManifest(
  chunkCount: number,
  chunksPerFile: number
): { manifest: Manifest; blobs: Map<string, Buffer>; expected: Map<string, Buffer> } {
  const manifest = buildManifest()
  const blobs = new Map<string, Buffer>()
  const expected = new Map<string, Buffer>()
  manifest.chunks = []
  manifest.files = []
  for (let i = 0; i < chunkCount; i++) {
    const guid = manyGuid(i)
    manifest.chunks.push(chunkInfo(guid, manyPayload(i), i % 100))
    blobs.set(guid, buildChunkBlob(guid, manyPayload(i)))
  }
  for (let f = 0; f * chunksPerFile < chunkCount; f++) {
    const ids = Array.from(
      { length: Math.min(chunksPerFile, chunkCount - f * chunksPerFile) },
      (_, k) => f * chunksPerFile + k
    )
    const bytesOut = Buffer.concat(ids.map(manyPayload))
    const filename = `Content/File${f}.bin`
    expected.set(filename, bytesOut)
    manifest.files.push({
      filename,
      symlinkTarget: '',
      sha1: sha1Upper(bytesOut),
      fileMetaFlags: 0,
      installTags: [],
      chunkParts: ids.map((i) => ({ chunkGuid: manyGuid(i), offset: 0, size: 96 })),
      fileSize: bytesOut.length
    })
  }
  return { manifest, blobs, expected }
}

function guidFromUrl(url: string): string {
  const m = /_([0-9A-F]{32})\.chunk/.exec(url)
  if (!m) throw new Error(`no guid in ${url}`)
  return m[1]
}

/** fetchImpl stub with latency that records concurrency and call order. */
function latencyFetch(
  blobs: Map<string, Buffer>,
  opts: { delayMs?: number; failGuid?: string } = {}
): {
  fetchImpl: typeof fetch
  calls: string[]
  maxInFlight: () => number
} {
  let inFlight = 0
  let max = 0
  const calls: string[] = []
  const fetchImpl = (async (url: string) => {
    const guid = guidFromUrl(url)
    calls.push(guid)
    inFlight++
    max = Math.max(max, inFlight)
    try {
      await new Promise((r) => setTimeout(r, opts.delayMs ?? 5))
      if (guid === opts.failGuid) return new Response('boom', { status: 500 })
      const blob = blobs.get(guid)
      if (!blob) return new Response('not found', { status: 404 })
      return new Response(blob, { status: 200 })
    } finally {
      inFlight--
    }
  }) as unknown as typeof fetch
  return { fetchImpl, calls, maxInFlight: () => max }
}

async function readAllFiles(
  dataDir: string,
  names: Iterable<string>
): Promise<Map<string, Buffer>> {
  const out = new Map<string, Buffer>()
  for (const n of names) out.set(n, await fsp.readFile(path.join(dataDir, n)))
  return out
}

describe('downloadAsset (parallel prefetch)', () => {
  it('keeps at most chunkConcurrency fetches in flight and reaches that limit', async () => {
    const { manifest, blobs, expected } = buildManyChunkManifest(40, 5)
    const stub = latencyFetch(blobs)
    const result = await downloadAsset(buildBundle(manifest), {
      vaultDir: tmpVault,
      fetchImpl: stub.fetchImpl,
      chunkConcurrency: 4
    })
    expect(stub.maxInFlight()).toBe(4)
    expect(stub.calls).toHaveLength(40)
    const written = await readAllFiles(result.dataDir, expected.keys())
    for (const [name, bytesOut] of expected) expect(written.get(name)!.equals(bytesOut)).toBe(true)
  })

  it('defaults to 16 concurrent chunk fetches', async () => {
    const { manifest, blobs } = buildManyChunkManifest(60, 3)
    const stub = latencyFetch(blobs)
    await downloadAsset(buildBundle(manifest), { vaultDir: tmpVault, fetchImpl: stub.fetchImpl })
    expect(stub.maxInFlight()).toBe(16)
  })

  it('produces byte-identical files to a sequential (chunkConcurrency: 1) run', async () => {
    const { manifest, blobs, expected } = buildManyChunkManifest(30, 4)
    // Add a file that reuses chunks non-adjacently to exercise the shared path.
    const reuseBytes = Buffer.concat([manyPayload(2), manyPayload(25), manyPayload(2)])
    manifest.files.push({
      filename: 'Content/Reuse.bin',
      symlinkTarget: '',
      sha1: sha1Upper(reuseBytes),
      fileMetaFlags: 0,
      installTags: [],
      chunkParts: [2, 25, 2].map((i) => ({ chunkGuid: manyGuid(i), offset: 0, size: 96 })),
      fileSize: reuseBytes.length
    })
    expected.set('Content/Reuse.bin', reuseBytes)

    const seq = latencyFetch(blobs, { delayMs: 1 })
    const seqResult = await downloadAsset(buildBundle(manifest), {
      vaultDir: path.join(tmpVault, 'seq'),
      fetchImpl: seq.fetchImpl,
      chunkConcurrency: 1
    })
    const par = latencyFetch(blobs, { delayMs: 1 })
    const parResult = await downloadAsset(buildBundle(manifest), {
      vaultDir: path.join(tmpVault, 'par'),
      fetchImpl: par.fetchImpl,
      chunkConcurrency: 8
    })
    expect(seq.maxInFlight()).toBe(1)
    expect(seq.calls).toHaveLength(30)
    expect(par.calls).toHaveLength(30)
    const a = await readAllFiles(seqResult.dataDir, expected.keys())
    const b = await readAllFiles(parResult.dataDir, expected.keys())
    for (const [name, bytesOut] of expected) {
      expect(a.get(name)!.equals(bytesOut)).toBe(true)
      expect(b.get(name)!.equals(bytesOut)).toBe(true)
    }
  })

  it('fetches a chunk shared by two non-adjacent files exactly once', async () => {
    const { manifest, blobs } = buildManyChunkManifest(20, 2)
    // First file already uses chunk 0; make the last file use it too.
    const last = manifest.files[manifest.files.length - 1]
    last.chunkParts.push({ chunkGuid: manyGuid(0), offset: 0, size: 96 })
    const lastBytes = Buffer.concat([manyPayload(18), manyPayload(19), manyPayload(0)])
    last.sha1 = sha1Upper(lastBytes)
    last.fileSize = lastBytes.length

    const stub = latencyFetch(blobs)
    const result = await downloadAsset(buildBundle(manifest), {
      vaultDir: tmpVault,
      fetchImpl: stub.fetchImpl,
      chunkConcurrency: 4
    })
    expect(stub.calls.filter((g) => g === manyGuid(0))).toHaveLength(1)
    expect(stub.calls).toHaveLength(20)
    const lastOnDisk = await fsp.readFile(path.join(result.dataDir, last.filename))
    expect(lastOnDisk.equals(lastBytes)).toBe(true)
  })

  it('persists only shared chunks to the disk cache', async () => {
    const { manifest, blobs } = buildManyChunkManifest(10, 2)
    // Chunk 0 is shared by file 0 and a trailing file; chunk 9 fails so the
    // run stops and leaves the cache dir behind for inspection.
    manifest.files.push({
      filename: 'Content/Tail.bin',
      symlinkTarget: '',
      sha1: '',
      fileMetaFlags: 0,
      installTags: [],
      chunkParts: [{ chunkGuid: manyGuid(0), offset: 0, size: 96 }],
      fileSize: 96
    })
    const stub = latencyFetch(blobs, { failGuid: manyGuid(9) })
    await expect(
      downloadAsset(buildBundle(manifest), {
        vaultDir: tmpVault,
        fetchImpl: stub.fetchImpl,
        chunkConcurrency: 2
      })
    ).rejects.toThrow(/500/)
    const cacheDir = path.join(tmpVault, 'TestAsset_build-1', 'cache')
    const cached = await fsp.readdir(cacheDir)
    expect(cached).toHaveLength(1)
    expect(cached[0]).toContain(manyGuid(0))
  })

  it('does not refetch chunks for files that are already complete on disk', async () => {
    const { manifest, blobs } = buildManyChunkManifest(12, 3)
    const first = latencyFetch(blobs, { delayMs: 1 })
    await downloadAsset(buildBundle(manifest), { vaultDir: tmpVault, fetchImpl: first.fetchImpl })
    const second = latencyFetch(blobs, { delayMs: 1 })
    const result = await downloadAsset(buildBundle(manifest), {
      vaultDir: tmpVault,
      fetchImpl: second.fetchImpl
    })
    expect(second.calls).toHaveLength(0)
    expect(result.files.every((f) => f.skipped)).toBe(true)
    expect(result.bytesWritten).toBe(0)
  })

  it('fails the download with the chunk error when a fetch fails', async () => {
    const { manifest, blobs } = buildManyChunkManifest(30, 3)
    const stub = latencyFetch(blobs, { failGuid: manyGuid(7) })
    await expect(
      downloadAsset(buildBundle(manifest), {
        vaultDir: tmpVault,
        fetchImpl: stub.fetchImpl,
        chunkConcurrency: 4
      })
    ).rejects.toThrow(new RegExp(`Chunk ${manyGuid(7)} fetch returned 500`))
  })

  it('stops issuing fetches on abort, rejects with DownloadCancelledError, leaks no rejection', async () => {
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason)
    }
    process.on('unhandledRejection', onUnhandled)
    try {
      const { manifest, blobs } = buildManyChunkManifest(50, 5)
      const ac = new AbortController()
      const inner = latencyFetch(blobs, { delayMs: 10 })
      const fetchImpl = ((url: string) => {
        if (inner.calls.length === 6) ac.abort()
        return inner.fetchImpl(url)
      }) as unknown as typeof fetch

      await expect(
        downloadAsset(buildBundle(manifest), {
          vaultDir: tmpVault,
          fetchImpl,
          chunkConcurrency: 3,
          signal: ac.signal
        })
      ).rejects.toBeInstanceOf(DownloadCancelledError)
      const callsAtReject = inner.calls.length
      // Let any in-flight fetch settle; nothing new may be scheduled.
      await new Promise((r) => setTimeout(r, 60))
      expect(inner.calls.length).toBe(callsAtReject)
      expect(inner.calls.length).toBeLessThan(10)
      expect(unhandled).toEqual([])
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })

  it('logs one download stats line at the end', async () => {
    const { manifest, blobs } = buildManyChunkManifest(8, 2)
    const stub = latencyFetch(blobs, { delayMs: 1 })
    const lines: string[] = []
    await downloadAsset(buildBundle(manifest), {
      vaultDir: tmpVault,
      fetchImpl: stub.fetchImpl,
      onLog: (l) => lines.push(l)
    })
    const stats = lines.filter((l) => l.startsWith('download stats:'))
    expect(stats).toHaveLength(1)
    expect(stats[0]).toMatch(
      /^download stats: [\d.]+ MB in [\d.]+ s \([\d.]+ MB\/s\), 8 chunks, avg fetch [\d.]+ ms, avg decode [\d.]+ ms/
    )
  })

  it('reports progress inside a large file, not only at file boundaries', async () => {
    // One file of 8 parts x 96 bytes = 768 bytes.
    const { manifest, blobs } = buildManyChunkManifest(8, 8)
    const stub = latencyFetch(blobs, { delayMs: 1 })
    const seen: Array<{ bytesDone: number; currentFile: string | null }> = []
    await downloadAsset(buildBundle(manifest), {
      vaultDir: tmpVault,
      fetchImpl: stub.fetchImpl,
      progressStepBytes: 150,
      onProgress: (p) => seen.push({ bytesDone: p.bytesDone, currentFile: p.currentFile })
    })
    const midFile = seen.filter((p) => p.bytesDone > 0 && p.bytesDone < 768)
    expect(midFile.length).toBeGreaterThanOrEqual(3)
    expect(midFile.every((p) => p.currentFile === 'Content/File0.bin')).toBe(true)
    for (let i = 1; i < seen.length; i++) {
      expect(seen[i].bytesDone).toBeGreaterThanOrEqual(seen[i - 1].bytesDone)
    }
    expect(seen.at(-1)?.bytesDone).toBe(768)
  })
})
