import { describe, it, expect } from 'vitest'
import { deflateSync } from 'node:zlib'
import { createHash } from 'node:crypto'
import { parseManifest } from './manifest-parser'
import { MANIFEST_MAGIC } from './parse-manifest-header'
import {
  bytes,
  fstring,
  guidHex,
  int32le,
  int64le,
  int8,
  sha1Hex,
  uint32le,
  uint64le,
  uint8
} from './test-fixtures'

/** Builds the uncompressed "data" portion of a manifest (meta + chunks + files + custom fields). */
function buildDataSection(): Buffer {
  const guid1 = '00000000000000000000000000000001'

  // FManifestMeta (sectionVersion=2)
  const metaBody = bytes(
    uint8(2),
    uint32le(18),                              // featureLevel
    uint8(0),                                  // bIsFileData
    uint32le(42),                              // appId
    fstring('TestAsset'),
    fstring('1.0.0'),
    fstring(''),
    fstring(''),
    int32le(0),
    fstring(''),
    fstring(''),
    fstring(''),
    fstring('build-id-test'),
    fstring(''),
    fstring('')
  )
  const meta = bytes(uint32le(4 + metaBody.length), metaBody)

  // FChunkDataList (1 chunk)
  const chunkBody = bytes(
    uint8(1),
    int32le(1),
    guidHex(guid1),
    uint64le(0xdeadbeefcafef00dn),
    sha1Hex('AA'.repeat(20)),
    int8(3),
    int32le(1024),
    int64le(500n)
  )
  const chunks = bytes(uint32le(4 + chunkBody.length), chunkBody)

  // FFileManifestList (1 file, 1 chunk part, version=0)
  const chunkPart = bytes(
    uint32le(4 + 16 + 4 + 4),
    guidHex(guid1),
    uint32le(0),
    uint32le(50)
  )
  const filesBody = bytes(
    uint8(0),
    int32le(1),
    fstring('Content/Foo.uasset'),
    fstring(''),
    sha1Hex('BB'.repeat(20)),
    uint8(0),
    int32le(0),
    int32le(1),
    chunkPart
  )
  const files = bytes(uint32le(4 + filesBody.length), filesBody)

  // FCustomFields (1 pair)
  const customBody = bytes(
    uint8(0),
    int32le(1),
    fstring('MarketplaceId'),
    fstring('uuid-123')
  )
  const custom = bytes(uint32le(4 + customBody.length), customBody)

  return Buffer.concat([meta, chunks, files, custom])
}

function buildManifest(compress: boolean): Buffer {
  const data = buildDataSection()
  const dataUncompressed = data
  const dataCompressed = compress ? deflateSync(data) : data
  const sha = createHash('sha1').update(dataUncompressed).digest()
  const headerSize = 41
  const header = bytes(
    uint32le(MANIFEST_MAGIC),
    uint32le(headerSize),
    uint32le(dataUncompressed.length),
    uint32le(dataCompressed.length),
    sha,
    uint8(compress ? 0x01 : 0x00),
    uint32le(18)
  )
  return Buffer.concat([header, dataCompressed])
}

describe('parseManifest (integration)', () => {
  it('parses a complete uncompressed manifest blob', () => {
    const buf = buildManifest(false)
    const m = parseManifest(buf)
    expect(m.meta.appName).toBe('TestAsset')
    expect(m.meta.buildId).toBe('build-id-test')
    expect(m.chunks).toHaveLength(1)
    expect(m.chunks[0].guid).toBe('00000000000000000000000000000001')
    expect(m.chunks[0].rollingHash).toBe('DEADBEEFCAFEF00D')
    expect(m.chunks[0].groupNumber).toBe(3)
    expect(m.files).toHaveLength(1)
    expect(m.files[0].filename).toBe('Content/Foo.uasset')
    expect(m.files[0].chunkParts[0].chunkGuid).toBe('00000000000000000000000000000001')
    expect(m.files[0].chunkParts[0].size).toBe(50)
    expect(m.customFields).toEqual({ MarketplaceId: 'uuid-123' })
  })

  it('parses a complete zlib-compressed manifest blob', () => {
    const buf = buildManifest(true)
    const m = parseManifest(buf)
    expect(m.meta.appName).toBe('TestAsset')
    expect(m.files[0].fileSize).toBe(50)
  })

  it('throws if the inflated data SHA1 does not match the header SHA1', () => {
    const data = buildDataSection()
    const headerSize = 41
    const header = bytes(
      uint32le(MANIFEST_MAGIC),
      uint32le(headerSize),
      uint32le(data.length),
      uint32le(data.length),
      sha1Hex('FF'.repeat(20)),                 // wrong sha
      uint8(0x00),                              // uncompressed
      uint32le(18)
    )
    const buf = Buffer.concat([header, data])
    expect(() => parseManifest(buf)).toThrow(/SHA1 mismatch/)
  })

  it('throws when bIsFileData is true (v0a does not handle file-data builds)', () => {
    const data = bytes(
      // Meta with bIsFileData=1
      uint32le(4 + 1 + 4 + 1 + 4 + 4 + 4 + 4 + 4 + 4 + 4 + 4 + 4 + 4 + 4),
      uint8(2),
      uint32le(18),
      uint8(1),                                 // bIsFileData = true
      uint32le(0),
      fstring(''),
      fstring(''),
      fstring(''),
      fstring(''),
      int32le(0),
      fstring(''),
      fstring(''),
      fstring(''),
      fstring(''),
      fstring(''),
      fstring('')
    )
    const sha = createHash('sha1').update(data).digest()
    const buf = Buffer.concat([
      bytes(
        uint32le(MANIFEST_MAGIC),
        uint32le(41),
        uint32le(data.length),
        uint32le(data.length),
        sha,
        uint8(0x00),
        uint32le(18)
      ),
      data
    ])
    expect(() => parseManifest(buf)).toThrow(/file-data/i)
  })
})
