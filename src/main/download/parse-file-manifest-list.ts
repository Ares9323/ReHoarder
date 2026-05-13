import type { BinaryReader } from './binary-reader'
import type { ChunkPart, FileManifestEntry } from './manifest-types'

const VERSION_MIME_MD5_HASH = 1
const VERSION_SHA256_HASH = 2

function parseChunkPart(r: BinaryReader): ChunkPart {
  const start = r.position
  const partSize = r.readUInt32LE()
  const guid = r.readFGuid()
  const offset = r.readUInt32LE()
  const size = r.readUInt32LE()
  r.seek(start + partSize)
  return { chunkGuid: guid, offset, size }
}

export function parseFileManifestList(r: BinaryReader): FileManifestEntry[] {
  const start = r.position
  const sectionSize = r.readUInt32LE()
  const version = r.readUInt8()
  const count = r.readInt32LE()

  const filenames: string[] = []
  for (let i = 0; i < count; i++) filenames.push(r.readFString())

  const symlinkTargets: string[] = []
  for (let i = 0; i < count; i++) symlinkTargets.push(r.readFString())

  const sha1s: string[] = []
  for (let i = 0; i < count; i++) sha1s.push(r.readBytes(20).toString('hex').toUpperCase())

  const metaFlags: number[] = []
  for (let i = 0; i < count; i++) metaFlags.push(r.readUInt8())

  const installTagsPerFile: string[][] = []
  for (let i = 0; i < count; i++) {
    const c = r.readInt32LE()
    const tags: string[] = []
    for (let j = 0; j < c; j++) tags.push(r.readFString())
    installTagsPerFile.push(tags)
  }

  const chunkPartsPerFile: ChunkPart[][] = []
  for (let i = 0; i < count; i++) {
    const c = r.readInt32LE()
    const parts: ChunkPart[] = []
    for (let j = 0; j < c; j++) parts.push(parseChunkPart(r))
    chunkPartsPerFile.push(parts)
  }

  // MD5 + mime block, version-gated.
  if (version >= VERSION_MIME_MD5_HASH) {
    for (let i = 0; i < count; i++) {
      const hasMd5 = r.readUInt32LE()
      if (hasMd5 !== 0) r.readBytes(16) // discard md5 bytes
    }
    for (let i = 0; i < count; i++) r.readFString() // mimeType (discarded for v0a)
  }

  // SHA256 block, version-gated.
  if (version >= VERSION_SHA256_HASH) {
    for (let i = 0; i < count; i++) r.readBytes(32) // discard sha256
  }

  // Seek past any trailing bytes in the section.
  r.seek(start + sectionSize)

  const files: FileManifestEntry[] = []
  for (let i = 0; i < count; i++) {
    const fileSize = chunkPartsPerFile[i].reduce((acc, p) => acc + p.size, 0)
    files.push({
      filename: filenames[i],
      symlinkTarget: symlinkTargets[i],
      sha1: sha1s[i],
      fileMetaFlags: metaFlags[i],
      installTags: installTagsPerFile[i],
      chunkParts: chunkPartsPerFile[i],
      fileSize
    })
  }
  return files
}
