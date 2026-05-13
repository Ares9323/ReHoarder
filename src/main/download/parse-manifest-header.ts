import type { BinaryReader } from './binary-reader'

export const MANIFEST_MAGIC = 0x44bec00c

export interface ManifestHeader {
  headerSize: number
  dataSizeUncompressed: number
  dataSizeCompressed: number
  sha1Hex: string
  compressed: boolean
  encrypted: boolean
  /** EManifestVersion. Defaults to 9 (StoredAsBinaryData) when headerSize <= 37 — that's the version
   * boundary at which Epic split the header. Modern manifests are always 18+. */
  version: number
}

const ESTORED_AS_COMPRESSED = 0x01
const ESTORED_AS_ENCRYPTED = 0x02

const FALLBACK_VERSION_WHEN_HEADER_SIZE_IS_37 = 9

export function parseManifestHeader(r: BinaryReader): ManifestHeader {
  const start = r.position
  const magic = r.readUInt32LE()
  if (magic !== MANIFEST_MAGIC) {
    throw new Error(
      `Manifest header magic mismatch: got 0x${magic.toString(16)}, expected 0x${MANIFEST_MAGIC.toString(16)}`
    )
  }
  const headerSize = r.readUInt32LE()
  const dataSizeUncompressed = r.readUInt32LE()
  const dataSizeCompressed = r.readUInt32LE()
  const sha = r.readBytes(20)
  const sha1Hex = sha.toString('hex').toUpperCase()
  const storedAs = r.readUInt8()
  const encrypted = (storedAs & ESTORED_AS_ENCRYPTED) !== 0
  const compressed = (storedAs & ESTORED_AS_COMPRESSED) !== 0
  if (encrypted) {
    throw new Error('Manifest is encrypted (StoredAs bit 2 set); not supported')
  }
  let version: number
  if (headerSize > 37) {
    version = r.readUInt32LE()
  } else {
    version = FALLBACK_VERSION_WHEN_HEADER_SIZE_IS_37
  }
  // Seek past any trailing unknown bytes within the declared headerSize.
  r.seek(start + headerSize)
  return {
    headerSize,
    dataSizeUncompressed,
    dataSizeCompressed,
    sha1Hex,
    compressed,
    encrypted,
    version
  }
}
