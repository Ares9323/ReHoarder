import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { promises as fsp, existsSync } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { deflateSync } from 'node:zlib'
import { createHash } from 'node:crypto'
import { ChunkSource } from './chunk-source'
import { CHUNK_MAGIC } from './chunk-decoder'
import { poly64Hash } from './rolling-hash'
import { bytes, guidHex, uint32le, uint64le, uint8 } from './test-fixtures'

const GUID = '00000000000000000000000000000001'
const PAYLOAD = Buffer.from('hello chunk source payload'.repeat(20))

function buildChunkBlob(payload: Buffer): Buffer {
  const rolling = poly64Hash(payload)
  const sha = createHash('sha1').update(payload).digest()
  const stored = deflateSync(payload)
  const HEADER_SIZE = 66
  return bytes(
    uint32le(CHUNK_MAGIC),
    uint32le(3),
    uint32le(HEADER_SIZE),
    uint32le(stored.length),
    guidHex(GUID),
    uint64le(rolling),
    uint8(0x01),
    sha,
    uint8(0x03),
    uint32le(payload.length),
    stored
  )
}

const expectedChunk = {
  guid: GUID,
  rollingHash: poly64Hash(PAYLOAD).toString(16).toUpperCase().padStart(16, '0'),
  sha1: createHash('sha1').update(PAYLOAD).digest('hex').toUpperCase(),
  groupNumber: 7,
  windowSize: 1024,
  fileSize: 1000
}

let tmpDir: string

beforeEach(async () => {
  tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'rh-chunk-source-'))
})

afterEach(async () => {
  await fsp.rm(tmpDir, { recursive: true, force: true })
})

describe('ChunkSource', () => {
  it('fetches a chunk from the CDN on first request and writes it to disk', async () => {
    const blob = buildChunkBlob(PAYLOAD)
    const fetchMock = vi.fn().mockResolvedValue(new Response(blob, { status: 200 }))
    const source = new ChunkSource({
      fetchImpl: fetchMock as unknown as typeof fetch,
      baseUri: 'https://cdn.example/foo/CloudDir/',
      cacheDir: tmpDir,
      manifestFeatureLevel: 18
    })

    const payload = await source.get(expectedChunk)

    expect(payload.equals(PAYLOAD)).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const expectedUrl = `https://cdn.example/foo/CloudDir/ChunksV4/07/${expectedChunk.rollingHash}_${GUID}.chunk`
    expect(fetchMock.mock.calls[0][0]).toBe(expectedUrl)

    // Disk cache contains the *decoded* payload (matches the file
    // assembler's expectation that cache hits return ready-to-slice bytes).
    const cachePath = path.join(tmpDir, `${expectedChunk.rollingHash}_${GUID}.chunk`)
    expect(existsSync(cachePath)).toBe(true)
    expect((await fsp.readFile(cachePath)).equals(PAYLOAD)).toBe(true)
  })

  it('serves a cache hit without calling fetch', async () => {
    const cachePath = path.join(tmpDir, `${expectedChunk.rollingHash}_${GUID}.chunk`)
    await fsp.writeFile(cachePath, PAYLOAD)

    const fetchMock = vi.fn()
    const source = new ChunkSource({
      fetchImpl: fetchMock as unknown as typeof fetch,
      baseUri: 'https://cdn.example/CloudDir/',
      cacheDir: tmpDir,
      manifestFeatureLevel: 18
    })

    const payload = await source.get(expectedChunk)
    expect(payload.equals(PAYLOAD)).toBe(true)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rejects a corrupted cache file (Poly64 mismatch) and re-fetches from CDN', async () => {
    const cachePath = path.join(tmpDir, `${expectedChunk.rollingHash}_${GUID}.chunk`)
    await fsp.writeFile(cachePath, Buffer.from('corrupt bytes that wont hash'))

    const blob = buildChunkBlob(PAYLOAD)
    const fetchMock = vi.fn().mockResolvedValue(new Response(blob, { status: 200 }))
    const source = new ChunkSource({
      fetchImpl: fetchMock as unknown as typeof fetch,
      baseUri: 'https://cdn.example/CloudDir/',
      cacheDir: tmpDir,
      manifestFeatureLevel: 18
    })

    const payload = await source.get(expectedChunk)
    expect(payload.equals(PAYLOAD)).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    // Cache has been refreshed with the good data.
    expect((await fsp.readFile(cachePath)).equals(PAYLOAD)).toBe(true)
  })

  it('dedups concurrent requests for the same chunk URL (only one fetch)', async () => {
    const blob = buildChunkBlob(PAYLOAD)
    let resolveBlob: ((r: Response) => void) | undefined
    const fetchMock = vi.fn().mockReturnValue(
      new Promise<Response>((r) => {
        resolveBlob = r
      })
    )
    const source = new ChunkSource({
      fetchImpl: fetchMock as unknown as typeof fetch,
      baseUri: 'https://cdn.example/CloudDir/',
      cacheDir: tmpDir,
      manifestFeatureLevel: 18
    })

    const [p1, p2] = [source.get(expectedChunk), source.get(expectedChunk)]
    // Let both promises start; both should be awaiting the same in-flight fetch.
    await new Promise((r) => setImmediate(r))
    expect(fetchMock).toHaveBeenCalledTimes(1)
    // Now fulfill the fetch and verify both consumers got the right bytes.
    resolveBlob!(new Response(blob, { status: 200 }))
    const [a, b] = await Promise.all([p1, p2])
    expect(a.equals(PAYLOAD)).toBe(true)
    expect(b.equals(PAYLOAD)).toBe(true)
  })

  it('throws when the CDN returns non-2xx', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response('', { status: 503 }))
    const source = new ChunkSource({
      fetchImpl: fetchMock as unknown as typeof fetch,
      baseUri: 'https://cdn.example/CloudDir/',
      cacheDir: tmpDir,
      manifestFeatureLevel: 18
    })
    await expect(source.get(expectedChunk)).rejects.toThrow(/503/)
  })

  it('uses ChunksV3 subdir when the manifest feature level is below 15', async () => {
    const blob = buildChunkBlob(PAYLOAD)
    const fetchMock = vi.fn().mockResolvedValue(new Response(blob, { status: 200 }))
    const source = new ChunkSource({
      fetchImpl: fetchMock as unknown as typeof fetch,
      baseUri: 'https://cdn.example/CloudDir/',
      cacheDir: tmpDir,
      manifestFeatureLevel: 10 // <15 → ChunksV3
    })
    await source.get(expectedChunk)
    expect(fetchMock.mock.calls[0][0]).toContain('/ChunksV3/')
  })
})
