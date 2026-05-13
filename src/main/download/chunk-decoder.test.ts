import { describe, it, expect } from 'vitest'
import { deflateSync } from 'node:zlib'
import { createHash } from 'node:crypto'
import { decodeChunk, CHUNK_MAGIC } from './chunk-decoder'
import { poly64Hash } from './rolling-hash'
import {
  bytes,
  guidHex,
  sha1Hex,
  uint32le,
  uint64le,
  uint8
} from './test-fixtures'

const GUID = '00000000000000000000000000000001'

function buildChunk(payload: Buffer, opts: { compress: boolean; hashType: number }): {
  raw: Buffer
  expected: { guid: string; rollingHash: string; sha1: string }
} {
  const rolling = poly64Hash(payload)
  const sha = createHash('sha1').update(payload).digest()
  const stored = opts.compress ? deflateSync(payload) : payload
  const HEADER_SIZE = 66 // v3 layout
  const header = bytes(
    uint32le(CHUNK_MAGIC),
    uint32le(3), // EChunkVersion = StoresDataSizeUncompressed
    uint32le(HEADER_SIZE),
    uint32le(stored.length),
    guidHex(GUID),
    uint64le(rolling),
    uint8(opts.compress ? 0x01 : 0x00),
    sha,
    uint8(opts.hashType),
    uint32le(payload.length)
  )
  return {
    raw: Buffer.concat([header, stored]),
    expected: {
      guid: GUID,
      rollingHash: rolling.toString(16).toUpperCase().padStart(16, '0'),
      sha1: sha.toString('hex').toUpperCase()
    }
  }
}

describe('decodeChunk', () => {
  it('decodes a compressed v3 chunk with poly64+sha1 hash type', () => {
    const payload = Buffer.from('chunk-payload-bytes '.repeat(50))
    const { raw, expected } = buildChunk(payload, { compress: true, hashType: 0x03 })
    const decoded = decodeChunk(raw, expected)
    expect(decoded.equals(payload)).toBe(true)
  })

  it('decodes an uncompressed v3 chunk', () => {
    const payload = Buffer.from('uncompressed bytes')
    const { raw, expected } = buildChunk(payload, { compress: false, hashType: 0x03 })
    expect(decodeChunk(raw, expected).equals(payload)).toBe(true)
  })

  it('accepts chunks with only the rolling hash (hashType = 0x01)', () => {
    const payload = Buffer.from('poly-only')
    const { raw, expected } = buildChunk(payload, { compress: false, hashType: 0x01 })
    expect(decodeChunk(raw, expected).equals(payload)).toBe(true)
  })

  it('throws on magic mismatch', () => {
    const buf = bytes(uint32le(0xdeadbeef), uint32le(3))
    expect(() =>
      decodeChunk(buf, { guid: GUID, rollingHash: '0'.repeat(16), sha1: '0'.repeat(40) })
    ).toThrow(/magic mismatch/i)
  })

  it('throws when storedAs declares encryption', () => {
    const payload = Buffer.from('x')
    const { expected } = buildChunk(payload, { compress: false, hashType: 0x03 })
    const HEADER_SIZE = 66
    const buf = bytes(
      uint32le(CHUNK_MAGIC),
      uint32le(3),
      uint32le(HEADER_SIZE),
      uint32le(payload.length),
      guidHex(GUID),
      uint64le(0n),
      uint8(0x02), // encrypted bit
      sha1Hex('00'.repeat(20)),
      uint8(0x00),
      uint32le(payload.length),
      payload
    )
    expect(() => decodeChunk(buf, expected)).toThrow(/encrypted/i)
  })

  it('throws when the rolling hash does not match', () => {
    const payload = Buffer.from('hello')
    const { raw } = buildChunk(payload, { compress: false, hashType: 0x01 })
    expect(() =>
      decodeChunk(raw, {
        guid: GUID,
        rollingHash: 'FFFFFFFFFFFFFFFF',
        sha1: '0'.repeat(40)
      })
    ).toThrow(/rolling hash mismatch/i)
  })

  it('throws when the SHA1 does not match', () => {
    const payload = Buffer.from('world')
    const { raw, expected } = buildChunk(payload, { compress: false, hashType: 0x03 })
    expect(() =>
      decodeChunk(raw, { ...expected, sha1: 'F'.repeat(40) })
    ).toThrow(/sha1 mismatch/i)
  })

  it('throws when the GUID in the header does not match the expected GUID', () => {
    const payload = Buffer.from('wrong-guid')
    const { raw, expected } = buildChunk(payload, { compress: false, hashType: 0x03 })
    expect(() =>
      decodeChunk(raw, { ...expected, guid: 'FF'.repeat(16) })
    ).toThrow(/guid mismatch/i)
  })
})
