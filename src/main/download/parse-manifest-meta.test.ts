import { describe, it, expect } from 'vitest'
import { BinaryReader } from './binary-reader'
import { parseManifestMeta } from './parse-manifest-meta'
import { bytes, fstring, int32le, uint32le, uint8 } from './test-fixtures'

function metaBody(sectionVersion: number): Buffer {
  const body = bytes(
    uint8(sectionVersion),
    uint32le(18),                              // featureLevel
    uint8(0),                                  // bIsFileData
    uint32le(12345),                           // appId
    fstring('PlantMonsterPack'),
    fstring('1.0.0'),
    fstring(''),                               // launchExe
    fstring(''),                               // launchCommand
    int32le(0),                                // prereqIds count
    fstring(''),                               // prereqName
    fstring(''),                               // prereqPath
    fstring(''),                               // prereqArgs
    fstring('build-uuid-123')                  // buildId (v>=1)
  )
  const v2Extras = sectionVersion >= 2
    ? bytes(fstring('uninstall.exe'), fstring('-silent'))
    : Buffer.alloc(0)
  return Buffer.concat([body, v2Extras])
}

describe('parseManifestMeta', () => {
  it('parses a sectionVersion=2 meta with uninstall fields', () => {
    const body = metaBody(2)
    const buf = bytes(uint32le(4 + body.length), body)
    const r = new BinaryReader(buf)
    const meta = parseManifestMeta(r)
    expect(meta.featureLevel).toBe(18)
    expect(meta.bIsFileData).toBe(false)
    expect(meta.appId).toBe(12345)
    expect(meta.appName).toBe('PlantMonsterPack')
    expect(meta.buildVersion).toBe('1.0.0')
    expect(meta.buildId).toBe('build-uuid-123')
    expect(meta.uninstallExe).toBe('uninstall.exe')
    expect(meta.uninstallCommand).toBe('-silent')
    expect(r.position).toBe(buf.length)
  })

  it('handles sectionVersion=1 (no uninstall fields)', () => {
    const body = metaBody(1)
    const buf = bytes(uint32le(4 + body.length), body)
    const r = new BinaryReader(buf)
    const meta = parseManifestMeta(r)
    expect(meta.uninstallExe).toBe('')
    expect(meta.uninstallCommand).toBe('')
  })

  it('parses prereqIds array of multiple strings', () => {
    const body = bytes(
      uint8(2),                                // sectionVersion
      uint32le(18),
      uint8(0),
      uint32le(0),
      fstring(''),                             // appName
      fstring(''),                             // buildVersion
      fstring(''),
      fstring(''),
      int32le(2),                              // prereqIds count
      fstring('id-A'),
      fstring('id-B'),
      fstring(''),
      fstring(''),
      fstring(''),
      fstring('bid'),
      fstring(''),
      fstring('')
    )
    const buf = bytes(uint32le(4 + body.length), body)
    const r = new BinaryReader(buf)
    const meta = parseManifestMeta(r)
    expect(meta.prereqIds).toEqual(['id-A', 'id-B'])
  })

  it('respects sectionSize and seeks past unknown trailing bytes', () => {
    const body = bytes(metaBody(2), Buffer.from([0xff, 0xff, 0xff]))
    const buf = bytes(uint32le(4 + body.length), body)
    const r = new BinaryReader(buf)
    parseManifestMeta(r)
    expect(r.position).toBe(buf.length)
  })
})
