import { describe, it, expect } from 'vitest'
import { BinaryReader } from './binary-reader'
import { parseChunkDataList } from './parse-chunk-data-list'
import {
  bytes,
  guidHex,
  int32le,
  int64le,
  int8,
  sha1Hex,
  uint32le,
  uint64le,
  uint8
} from './test-fixtures'

describe('parseChunkDataList', () => {
  it('parses a list of two chunks struct-of-arrays', () => {
    const guid1 = '00000000000000000000000000000001'
    const guid2 = '00000000000000000000000000000002'
    const sha1 = 'AA'.repeat(20)
    const sha2 = 'BB'.repeat(20)

    const body = bytes(
      uint8(1),                                // version
      int32le(2),                              // count
      // GUIDs
      guidHex(guid1),
      guidHex(guid2),
      // rolling hashes
      uint64le(0x1122334455667788n),
      uint64le(0x99aabbccddeeff00n),
      // sha1 (20 bytes each)
      sha1Hex(sha1),
      sha1Hex(sha2),
      // group numbers
      int8(7),
      int8(42),
      // window sizes
      int32le(1024),
      int32le(2048),
      // file sizes
      int64le(50000n),
      int64le(80000n)
    )
    const buf = bytes(uint32le(4 + body.length), body)
    const r = new BinaryReader(buf)
    const list = parseChunkDataList(r)
    expect(list).toHaveLength(2)
    expect(list[0].guid).toBe(guid1.toUpperCase())
    expect(list[0].rollingHash).toBe('1122334455667788'.toUpperCase())
    expect(list[0].sha1).toBe(sha1.toUpperCase())
    expect(list[0].groupNumber).toBe(7)
    expect(list[0].windowSize).toBe(1024)
    expect(list[0].fileSize).toBe(50000)
    expect(list[1].guid).toBe(guid2.toUpperCase())
    expect(list[1].rollingHash).toBe('99AABBCCDDEEFF00')
    expect(list[1].groupNumber).toBe(42)
    expect(list[1].fileSize).toBe(80000)
    expect(r.position).toBe(buf.length)
  })

  it('handles an empty chunk list (count=0)', () => {
    const body = bytes(uint8(1), int32le(0))
    const buf = bytes(uint32le(4 + body.length), body)
    const r = new BinaryReader(buf)
    expect(parseChunkDataList(r)).toEqual([])
  })
})
