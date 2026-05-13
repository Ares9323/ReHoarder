import { describe, it, expect } from 'vitest'
import { poly64Hash } from './rolling-hash'

describe('poly64Hash', () => {
  it('returns 0n for an empty buffer', () => {
    expect(poly64Hash(Buffer.alloc(0))).toBe(0n)
  })

  it('is deterministic for the same input', () => {
    const buf = Buffer.from('hello world repeated many times '.repeat(50))
    expect(poly64Hash(buf)).toBe(poly64Hash(buf))
  })

  it('differs for two different inputs of the same length', () => {
    const a = Buffer.from('hello world')
    const b = Buffer.from('Hello World')
    expect(poly64Hash(a)).not.toBe(poly64Hash(b))
  })

  it('produces a 64-bit value (fits in 16 hex chars)', () => {
    const buf = Buffer.from('arbitrary content ' + Date.now().toString())
    const hex = poly64Hash(buf).toString(16).toUpperCase().padStart(16, '0')
    expect(hex).toHaveLength(16)
    expect(hex).toMatch(/^[0-9A-F]{16}$/)
  })

  it('avalanches: flipping a single byte changes the output substantially', () => {
    const a = Buffer.from('0123456789abcdef0123456789abcdef')
    const b = Buffer.from(a)
    b[15] ^= 0x01
    const ha = poly64Hash(a)
    const hb = poly64Hash(b)
    expect(ha).not.toBe(hb)
    // XOR-popcount of the two hashes should be reasonably high; a hash
    // function that didn't avalanche would have only 1-2 bits flipped.
    const diff = ha ^ hb
    let popcount = 0
    for (let bit = 0n; bit < 64n; bit++) {
      if ((diff >> bit) & 1n) popcount++
    }
    expect(popcount).toBeGreaterThan(8)
  })
})
