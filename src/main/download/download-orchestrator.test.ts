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
