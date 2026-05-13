import { describe, it, expect } from 'vitest'
import { BinaryReader } from './binary-reader'
import { parseFileManifestList } from './parse-file-manifest-list'
import {
  bytes,
  fstring,
  guidHex,
  int32le,
  sha1Hex,
  uint32le,
  uint8
} from './test-fixtures'

/** A single FChunkPart packed as bytes. */
function chunkPart(guidHex32: string, offset: number, size: number): Buffer {
  const inner = bytes(guidHex(guidHex32), uint32le(offset), uint32le(size))
  const partSize = 4 + inner.length
  return bytes(uint32le(partSize), inner)
}

describe('parseFileManifestList', () => {
  it('parses a v=0 list (pre-MimeMD5Hash) with one file and two chunk parts', () => {
    const fileSha1 = 'CC'.repeat(20)
    const guid1 = '00000000000000000000000000000001'
    const guid2 = '00000000000000000000000000000002'
    const body = bytes(
      uint8(0),                                       // version (pre MD5/MIME/SHA256)
      int32le(1),                                     // count
      fstring('Engine/Plugins/Foo/Foo.uplugin'),      // filename
      fstring(''),                                    // symlink
      sha1Hex(fileSha1),                              // file sha1
      uint8(0),                                       // metaFlags
      // installTags array (count + items)
      int32le(0),
      // chunkParts array (count + items)
      int32le(2),
      chunkPart(guid1, 0, 100),
      chunkPart(guid2, 100, 200)
    )
    const buf = bytes(uint32le(4 + body.length), body)
    const r = new BinaryReader(buf)
    const files = parseFileManifestList(r)
    expect(files).toHaveLength(1)
    const f = files[0]
    expect(f.filename).toBe('Engine/Plugins/Foo/Foo.uplugin')
    expect(f.symlinkTarget).toBe('')
    expect(f.sha1).toBe(fileSha1.toUpperCase())
    expect(f.chunkParts).toHaveLength(2)
    expect(f.chunkParts[0]).toEqual({ chunkGuid: guid1.toUpperCase(), offset: 0, size: 100 })
    expect(f.chunkParts[1]).toEqual({ chunkGuid: guid2.toUpperCase(), offset: 100, size: 200 })
    expect(f.fileSize).toBe(300)
    expect(r.position).toBe(buf.length)
  })

  it('parses installTags per file', () => {
    const body = bytes(
      uint8(0),
      int32le(1),
      fstring('x.txt'),
      fstring(''),
      sha1Hex('00'.repeat(20)),
      uint8(0),
      int32le(2),
      fstring('Tag-A'),
      fstring('Tag-B'),
      int32le(0)
    )
    const buf = bytes(uint32le(4 + body.length), body)
    const r = new BinaryReader(buf)
    const files = parseFileManifestList(r)
    expect(files[0].installTags).toEqual(['Tag-A', 'Tag-B'])
  })

  it('skips MD5 + mime block when version >= MimeMD5Hash (1)', () => {
    const body = bytes(
      uint8(1),                                       // version with md5/mime
      int32le(1),
      fstring('a.txt'),
      fstring(''),
      sha1Hex('00'.repeat(20)),
      uint8(0),
      int32le(0),                                     // tags
      int32le(0),                                     // chunks
      uint32le(0),                                    // hasMd5 = 0
      fstring('text/plain')                           // mime
    )
    const buf = bytes(uint32le(4 + body.length), body)
    const r = new BinaryReader(buf)
    const files = parseFileManifestList(r)
    expect(files).toHaveLength(1)
    expect(files[0].fileSize).toBe(0)
    expect(r.position).toBe(buf.length)
  })

  it('skips SHA256 block when version >= SHA256Hash (2)', () => {
    const sha256 = '33'.repeat(32)
    const body = bytes(
      uint8(2),
      int32le(1),
      fstring('a.txt'),
      fstring(''),
      sha1Hex('00'.repeat(20)),
      uint8(0),
      int32le(0),
      int32le(0),
      uint32le(0),
      fstring(''),
      Buffer.from(sha256, 'hex')
    )
    const buf = bytes(uint32le(4 + body.length), body)
    const r = new BinaryReader(buf)
    const files = parseFileManifestList(r)
    expect(files).toHaveLength(1)
    expect(r.position).toBe(buf.length)
  })
})
