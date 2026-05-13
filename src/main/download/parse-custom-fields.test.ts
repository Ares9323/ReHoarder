import { describe, it, expect } from 'vitest'
import { BinaryReader } from './binary-reader'
import { parseCustomFields } from './parse-custom-fields'
import { bytes, fstring, int32le, uint32le, uint8 } from './test-fixtures'

describe('parseCustomFields', () => {
  it('parses key/value pairs', () => {
    const body = bytes(
      uint8(0),
      int32le(2),
      fstring('PluginName'),
      fstring('Author'),
      fstring('Foo'),
      fstring('Acme')
    )
    const buf = bytes(uint32le(4 + body.length), body)
    const r = new BinaryReader(buf)
    expect(parseCustomFields(r)).toEqual({
      PluginName: 'Foo',
      Author: 'Acme'
    })
    expect(r.position).toBe(buf.length)
  })

  it('returns an empty object for count=0', () => {
    const body = bytes(uint8(0), int32le(0))
    const buf = bytes(uint32le(4 + body.length), body)
    const r = new BinaryReader(buf)
    expect(parseCustomFields(r)).toEqual({})
  })
})
