import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fsp, existsSync } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { createHash } from 'node:crypto'
import { assembleFile } from './file-assembler'
import type { FileManifestEntry } from './manifest-types'

let tmpDir: string

beforeEach(async () => {
  tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'rh-assemble-'))
})

afterEach(async () => {
  await fsp.rm(tmpDir, { recursive: true, force: true })
})

function sha1Upper(buf: Buffer): string {
  return createHash('sha1').update(buf).digest('hex').toUpperCase()
}

const CHUNK_A = Buffer.from('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA') // 32 bytes
const CHUNK_B = Buffer.from('BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB') // 32 bytes

const GUID_A = '00000000000000000000000000000000A'.slice(0, 32)
const GUID_B = '0000000000000000000000000000000B'.padStart(32, '0')

/** Fake ChunkSource for tests — returns prepared buffers by GUID. */
class StubChunkSource {
  constructor(private readonly byGuid: Map<string, Buffer>) {}
  async get(chunk: { guid: string }): Promise<Buffer> {
    const buf = this.byGuid.get(chunk.guid.toUpperCase())
    if (!buf) throw new Error(`StubChunkSource: no buffer for ${chunk.guid}`)
    return buf
  }
}

describe('assembleFile', () => {
  it('writes a file from a single ChunkPart with the full chunk payload', async () => {
    const expected = CHUNK_A
    const entry: FileManifestEntry = {
      filename: 'a.bin',
      symlinkTarget: '',
      sha1: sha1Upper(expected),
      fileMetaFlags: 0,
      installTags: [],
      chunkParts: [{ chunkGuid: GUID_A, offset: 0, size: 32 }],
      fileSize: 32
    }
    const source = new StubChunkSource(new Map([[GUID_A, CHUNK_A]]))
    const dest = path.join(tmpDir, entry.filename)

    const result = await assembleFile(entry, source, dest)

    expect(result.skipped).toBe(false)
    expect((await fsp.readFile(dest)).equals(expected)).toBe(true)
    expect(existsSync(dest + '.temp')).toBe(false)
  })

  it('writes a file that spans two chunks with offsets', async () => {
    // Slice the second half of CHUNK_A and the first half of CHUNK_B.
    const expected = Buffer.concat([CHUNK_A.subarray(16, 32), CHUNK_B.subarray(0, 16)])
    const entry: FileManifestEntry = {
      filename: 'spans.bin',
      symlinkTarget: '',
      sha1: sha1Upper(expected),
      fileMetaFlags: 0,
      installTags: [],
      chunkParts: [
        { chunkGuid: GUID_A, offset: 16, size: 16 },
        { chunkGuid: GUID_B, offset: 0, size: 16 }
      ],
      fileSize: 32
    }
    const source = new StubChunkSource(
      new Map([
        [GUID_A, CHUNK_A],
        [GUID_B, CHUNK_B]
      ])
    )
    const dest = path.join(tmpDir, 'spans.bin')

    const result = await assembleFile(entry, source, dest)

    expect(result.skipped).toBe(false)
    expect((await fsp.readFile(dest)).equals(expected)).toBe(true)
  })

  it('skips writing when the file already exists with matching SHA1', async () => {
    const expected = CHUNK_A
    const entry: FileManifestEntry = {
      filename: 'existing.bin',
      symlinkTarget: '',
      sha1: sha1Upper(expected),
      fileMetaFlags: 0,
      installTags: [],
      chunkParts: [{ chunkGuid: GUID_A, offset: 0, size: 32 }],
      fileSize: 32
    }
    const dest = path.join(tmpDir, entry.filename)
    await fsp.writeFile(dest, expected)
    const sourceMtimeBefore = (await fsp.stat(dest)).mtimeMs

    const source = new StubChunkSource(new Map([[GUID_A, CHUNK_A]]))
    const result = await assembleFile(entry, source, dest)

    expect(result.skipped).toBe(true)
    // File wasn't rewritten (mtime preserved).
    const sourceMtimeAfter = (await fsp.stat(dest)).mtimeMs
    expect(sourceMtimeAfter).toBe(sourceMtimeBefore)
  })

  it('rewrites the file when the existing copy has the wrong SHA1', async () => {
    const expected = CHUNK_A
    const entry: FileManifestEntry = {
      filename: 'corrupt.bin',
      symlinkTarget: '',
      sha1: sha1Upper(expected),
      fileMetaFlags: 0,
      installTags: [],
      chunkParts: [{ chunkGuid: GUID_A, offset: 0, size: 32 }],
      fileSize: 32
    }
    const dest = path.join(tmpDir, entry.filename)
    await fsp.writeFile(dest, Buffer.from('this is the wrong bytes ___'))

    const source = new StubChunkSource(new Map([[GUID_A, CHUNK_A]]))
    const result = await assembleFile(entry, source, dest)

    expect(result.skipped).toBe(false)
    expect((await fsp.readFile(dest)).equals(expected)).toBe(true)
  })

  it('creates parent directories as needed', async () => {
    const expected = CHUNK_A
    const entry: FileManifestEntry = {
      filename: 'Engine/Plugins/Foo/Foo.uplugin',
      symlinkTarget: '',
      sha1: sha1Upper(expected),
      fileMetaFlags: 0,
      installTags: [],
      chunkParts: [{ chunkGuid: GUID_A, offset: 0, size: 32 }],
      fileSize: 32
    }
    const dest = path.join(tmpDir, entry.filename)

    await assembleFile(entry, new StubChunkSource(new Map([[GUID_A, CHUNK_A]])), dest)

    expect(existsSync(dest)).toBe(true)
  })

  it('throws when the assembled SHA1 does not match the manifest', async () => {
    const entry: FileManifestEntry = {
      filename: 'bad.bin',
      symlinkTarget: '',
      sha1: 'F'.repeat(40),
      fileMetaFlags: 0,
      installTags: [],
      chunkParts: [{ chunkGuid: GUID_A, offset: 0, size: 32 }],
      fileSize: 32
    }
    const dest = path.join(tmpDir, entry.filename)
    const source = new StubChunkSource(new Map([[GUID_A, CHUNK_A]]))

    await expect(assembleFile(entry, source, dest)).rejects.toThrow(/sha1 mismatch/i)
    // Temp file should have been cleaned up.
    expect(existsSync(dest + '.temp')).toBe(false)
    expect(existsSync(dest)).toBe(false)
  })
})
