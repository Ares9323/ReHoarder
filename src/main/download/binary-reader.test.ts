import { describe, it, expect } from 'vitest'
import { BinaryReader } from './binary-reader'

describe('BinaryReader primitives', () => {
  it('reads a single uint32 little-endian and advances position by 4', () => {
    const buf = Buffer.from([0x78, 0x56, 0x34, 0x12])
    const r = new BinaryReader(buf)
    expect(r.position).toBe(0)
    expect(r.readUInt32LE()).toBe(0x12345678)
    expect(r.position).toBe(4)
  })
})

describe('BinaryReader more primitives', () => {
  it('reads uint8 and advances by 1', () => {
    const r = new BinaryReader(Buffer.from([0xab]))
    expect(r.readUInt8()).toBe(0xab)
    expect(r.position).toBe(1)
  })

  it('reads uint16 little-endian and advances by 2', () => {
    const r = new BinaryReader(Buffer.from([0x34, 0x12]))
    expect(r.readUInt16LE()).toBe(0x1234)
    expect(r.position).toBe(2)
  })

  it('reads int32 little-endian (signed)', () => {
    const r = new BinaryReader(Buffer.from([0xff, 0xff, 0xff, 0xff]))
    expect(r.readInt32LE()).toBe(-1)
  })

  it('reads int8 (signed)', () => {
    const r = new BinaryReader(Buffer.from([0x80]))
    expect(r.readInt8()).toBe(-128)
  })

  it('reads uint64 little-endian as bigint', () => {
    const r = new BinaryReader(Buffer.from([0x01, 0, 0, 0, 0, 0, 0, 0x80]))
    expect(r.readUInt64LE()).toBe(0x8000000000000001n)
  })

  it('reads int64 little-endian as bigint (signed)', () => {
    const r = new BinaryReader(Buffer.from([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]))
    expect(r.readInt64LE()).toBe(-1n)
  })

  it('reads a raw byte slice and advances position', () => {
    const r = new BinaryReader(Buffer.from([1, 2, 3, 4, 5]))
    const slice = r.readBytes(3)
    expect(Array.from(slice)).toEqual([1, 2, 3])
    expect(r.position).toBe(3)
  })

  it('readBytes returns a copy (mutations to the result do not affect the buffer)', () => {
    const src = Buffer.from([1, 2, 3])
    const r = new BinaryReader(src)
    const slice = r.readBytes(3)
    slice[0] = 99
    expect(src[0]).toBe(1)
  })

  it('seek moves position absolute', () => {
    const r = new BinaryReader(Buffer.from([0, 0, 0, 0, 0x11, 0x22, 0x33, 0x44]))
    r.seek(4)
    expect(r.readUInt32LE()).toBe(0x44332211)
  })

  it('throws when a read would go past EOB', () => {
    const r = new BinaryReader(Buffer.from([0]))
    expect(() => r.readUInt32LE()).toThrow(/exceeds buffer size/)
  })
})

describe('BinaryReader.readFString', () => {
  it('returns empty string when length=0 (no body bytes consumed)', () => {
    const r = new BinaryReader(Buffer.from([0, 0, 0, 0]))
    expect(r.readFString()).toBe('')
    expect(r.position).toBe(4)
  })

  it('reads UTF-8 with positive length (length includes the null terminator)', () => {
    // "hello" = 5 chars + 1 null = 6 bytes → length field = 6
    const buf = Buffer.concat([
      Buffer.from([6, 0, 0, 0]),
      Buffer.from('hello', 'utf8'),
      Buffer.from([0])
    ])
    const r = new BinaryReader(buf)
    expect(r.readFString()).toBe('hello')
    expect(r.position).toBe(4 + 6)
  })

  it('reads UTF-16LE with negative length', () => {
    // "héllo" — encode as UTF-16LE + null uint16, length = -(chars+1) = -6
    const utf16 = Buffer.from('héllo\0', 'utf16le') // 6 chars × 2 = 12 bytes
    const buf = Buffer.concat([
      Buffer.from([0xfa, 0xff, 0xff, 0xff]), // int32 = -6
      utf16
    ])
    const r = new BinaryReader(buf)
    expect(r.readFString()).toBe('héllo')
    expect(r.position).toBe(4 + 12)
  })

  it('handles a UTF-8 string whose body has no trailing null gracefully', () => {
    // length=6 but we provide only "hello" with no null — still reads 6 bytes, decoded string trims null
    const buf = Buffer.concat([
      Buffer.from([6, 0, 0, 0]),
      Buffer.from('hello!', 'utf8') // length-1 bytes, no trailing null
    ])
    const r = new BinaryReader(buf)
    // We consume `length` bytes and decode all but the last; final byte assumed null.
    expect(r.readFString()).toBe('hello')
  })
})
