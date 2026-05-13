import { inflateSync } from 'node:zlib'
import { createHash } from 'node:crypto'
import { BinaryReader } from './binary-reader'
import { poly64Hash } from './rolling-hash'

export const CHUNK_MAGIC = 0xb1fe3aa2

const VERSION_STORES_SHA_AND_HASH_TYPE = 2
const VERSION_STORES_DATA_SIZE_UNCOMPRESSED = 3

const STORED_AS_COMPRESSED = 0x01
const STORED_AS_ENCRYPTED = 0x02

const HASH_TYPE_POLY64 = 0x01
const HASH_TYPE_SHA1 = 0x02

export interface ChunkExpectation {
  /** 32-char hex uppercase. Used to validate the chunk header's GUID. */
  guid: string
  /** 16-char hex uppercase. */
  rollingHash: string
  /** 40-char hex uppercase. Empty / zeroed when the chunk lacks a SHA1 (hashType bit 2 unset). */
  sha1: string
}

/**
 * Parse a single `.chunk` binary blob, decompress (zlib if flagged), and
 * verify integrity against the manifest's expected hashes. Returns the raw
 * decompressed payload — the slice(s) into this payload are then assembled
 * by `file-assembler.ts`.
 *
 * Throws an `Error` with a descriptive message on any of:
 *   - magic mismatch
 *   - encrypted storage (unsupported)
 *   - declared GUID disagrees with the expected one
 *   - declared compressed size exceeds the buffer
 *   - inflated size disagrees with the v3 `dataSizeUncompressed` field
 *   - Poly64 mismatch (when hashType bit 1 is set)
 *   - SHA1 mismatch  (when hashType bit 2 is set)
 */
export function decodeChunk(buf: Buffer, expected: ChunkExpectation): Buffer {
  const r = new BinaryReader(buf)
  const start = r.position
  const magic = r.readUInt32LE()
  if (magic !== CHUNK_MAGIC) {
    throw new Error(
      `Chunk magic mismatch: got 0x${magic.toString(16)}, expected 0x${CHUNK_MAGIC.toString(16)}`
    )
  }
  const version = r.readUInt32LE()
  const headerSize = r.readUInt32LE()
  const dataSizeCompressed = r.readUInt32LE()
  const guid = r.readFGuid()
  const rollingHashHeader = r.readUInt64LE()
  const storedAs = r.readUInt8()

  if (guid !== expected.guid.toUpperCase()) {
    throw new Error(
      `Chunk GUID mismatch: header says ${guid}, manifest says ${expected.guid}`
    )
  }
  if ((storedAs & STORED_AS_ENCRYPTED) !== 0) {
    throw new Error(`Chunk ${guid} is encrypted; not supported`)
  }

  let sha1Header = ''
  let hashType = HASH_TYPE_POLY64
  if (version >= VERSION_STORES_SHA_AND_HASH_TYPE) {
    sha1Header = r.readBytes(20).toString('hex').toUpperCase()
    hashType = r.readUInt8()
  }
  let dataSizeUncompressed = 0
  let hasUncompressedSize = false
  if (version >= VERSION_STORES_DATA_SIZE_UNCOMPRESSED) {
    dataSizeUncompressed = r.readUInt32LE()
    hasUncompressedSize = true
  }

  r.seek(start + headerSize)

  if (start + headerSize + dataSizeCompressed > buf.length) {
    throw new Error(
      `Chunk ${guid} declares dataSizeCompressed=${dataSizeCompressed} but buffer ends earlier`
    )
  }
  const stored = r.readBytes(dataSizeCompressed)
  const payload =
    (storedAs & STORED_AS_COMPRESSED) !== 0 ? inflateSync(stored) : stored

  if (hasUncompressedSize && payload.length !== dataSizeUncompressed) {
    throw new Error(
      `Chunk ${guid} payload size mismatch: got ${payload.length}, expected ${dataSizeUncompressed}`
    )
  }

  if ((hashType & HASH_TYPE_POLY64) !== 0) {
    const actual = poly64Hash(payload).toString(16).toUpperCase().padStart(16, '0')
    // Verify both against the header value (catches manifest/header drift) and the
    // expected manifest value (catches header tampering).
    const headerHex = rollingHashHeader.toString(16).toUpperCase().padStart(16, '0')
    if (actual !== headerHex) {
      throw new Error(
        `Chunk ${guid} rolling hash mismatch (header): got ${actual}, expected ${headerHex}`
      )
    }
    if (actual !== expected.rollingHash.toUpperCase()) {
      throw new Error(
        `Chunk ${guid} rolling hash mismatch (manifest): got ${actual}, expected ${expected.rollingHash}`
      )
    }
  }
  if ((hashType & HASH_TYPE_SHA1) !== 0) {
    const actual = createHash('sha1').update(payload).digest('hex').toUpperCase()
    if (actual !== sha1Header) {
      throw new Error(
        `Chunk ${guid} sha1 mismatch (header): got ${actual}, expected ${sha1Header}`
      )
    }
    if (
      expected.sha1 &&
      expected.sha1 !== '0'.repeat(40) &&
      actual !== expected.sha1.toUpperCase()
    ) {
      throw new Error(
        `Chunk ${guid} sha1 mismatch (manifest): got ${actual}, expected ${expected.sha1}`
      )
    }
  }

  return payload
}
