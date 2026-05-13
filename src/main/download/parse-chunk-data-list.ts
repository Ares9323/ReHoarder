import type { BinaryReader } from './binary-reader'
import type { ChunkInfo } from './manifest-types'

export function parseChunkDataList(r: BinaryReader): ChunkInfo[] {
  const start = r.position
  const sectionSize = r.readUInt32LE()
  r.readUInt8() // version — currently unused but reserved
  const count = r.readInt32LE()
  const guids: string[] = []
  for (let i = 0; i < count; i++) {
    guids.push(r.readBytes(16).toString('hex').toUpperCase())
  }
  const rollingHashes: string[] = []
  for (let i = 0; i < count; i++) {
    rollingHashes.push(r.readUInt64LE().toString(16).toUpperCase().padStart(16, '0'))
  }
  const sha1s: string[] = []
  for (let i = 0; i < count; i++) {
    sha1s.push(r.readBytes(20).toString('hex').toUpperCase())
  }
  const groupNumbers: number[] = []
  for (let i = 0; i < count; i++) groupNumbers.push(r.readInt8())
  const windowSizes: number[] = []
  for (let i = 0; i < count; i++) windowSizes.push(r.readInt32LE())
  const fileSizes: number[] = []
  for (let i = 0; i < count; i++) fileSizes.push(Number(r.readInt64LE()))

  // Seek past trailing bytes inside the section.
  r.seek(start + sectionSize)

  const out: ChunkInfo[] = []
  for (let i = 0; i < count; i++) {
    out.push({
      guid: guids[i],
      rollingHash: rollingHashes[i],
      sha1: sha1s[i],
      groupNumber: groupNumbers[i],
      windowSize: windowSizes[i],
      fileSize: fileSizes[i]
    })
  }
  return out
}
