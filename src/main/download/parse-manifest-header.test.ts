import { describe, it, expect } from 'vitest'
import { BinaryReader } from './binary-reader'
import { parseManifestHeader, MANIFEST_MAGIC } from './parse-manifest-header'
import { bytes, sha1Hex, uint32le, uint8 } from './test-fixtures'

describe('parseManifestHeader', () => {
  it('parses a v18 header with compression flag set', () => {
    const buf = bytes(
      uint32le(MANIFEST_MAGIC),
      uint32le(41),                     // headerSize
      uint32le(0x1234),                 // dataSizeUncompressed
      uint32le(0x5678),                 // dataSizeCompressed
      sha1Hex('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'),
      uint8(0x01),                      // storedAs = compressed
      uint32le(18)                      // version
    )
    const r = new BinaryReader(buf)
    const header = parseManifestHeader(r)
    expect(header.dataSizeUncompressed).toBe(0x1234)
    expect(header.dataSizeCompressed).toBe(0x5678)
    expect(header.compressed).toBe(true)
    expect(header.encrypted).toBe(false)
    expect(header.version).toBe(18)
    expect(header.sha1Hex).toBe('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA')
    // Reader must be seeked past the header (41 bytes total).
    expect(r.position).toBe(41)
  })

  it('handles legacy 37-byte header (no explicit version field)', () => {
    const buf = bytes(
      uint32le(MANIFEST_MAGIC),
      uint32le(37),
      uint32le(100),
      uint32le(100),
      sha1Hex('BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB'),
      uint8(0x00)
    )
    const r = new BinaryReader(buf)
    const header = parseManifestHeader(r)
    expect(header.version).toBeGreaterThan(0)
    expect(header.compressed).toBe(false)
    expect(r.position).toBe(37)
  })

  it('throws on magic mismatch', () => {
    const buf = bytes(uint32le(0xdeadbeef), uint32le(41))
    const r = new BinaryReader(buf)
    expect(() => parseManifestHeader(r)).toThrow(/magic mismatch/)
  })

  it('throws when encrypted', () => {
    const buf = bytes(
      uint32le(MANIFEST_MAGIC),
      uint32le(41),
      uint32le(0),
      uint32le(0),
      sha1Hex('00'.repeat(20)),
      uint8(0x02),                      // storedAs = encrypted
      uint32le(18)
    )
    const r = new BinaryReader(buf)
    expect(() => parseManifestHeader(r)).toThrow(/encrypted/i)
  })
})
