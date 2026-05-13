import { inflateSync } from 'node:zlib'
import { createHash } from 'node:crypto'
import { BinaryReader } from './binary-reader'
import { parseManifestHeader } from './parse-manifest-header'
import { parseManifestMeta } from './parse-manifest-meta'
import { parseChunkDataList } from './parse-chunk-data-list'
import { parseFileManifestList } from './parse-file-manifest-list'
import { parseCustomFields } from './parse-custom-fields'
import type { Manifest } from './manifest-types'

/**
 * Parse an Epic Chunked Manifest binary blob (Fab CDN payload) into a typed
 * `Manifest` object. Throws on magic mismatch, encryption, decompression
 * mismatch, or SHA1 mismatch of the uncompressed data section.
 */
export function parseManifest(buf: Buffer): Manifest {
  const reader = new BinaryReader(buf)
  const header = parseManifestHeader(reader)

  const compressedData = reader.readBytes(header.dataSizeCompressed)
  let data: Buffer
  if (header.compressed) {
    data = inflateSync(compressedData)
  } else {
    data = compressedData
  }
  if (data.length !== header.dataSizeUncompressed) {
    throw new Error(
      `Manifest data size mismatch after decompression: got ${data.length}, expected ${header.dataSizeUncompressed}`
    )
  }
  const actualSha = createHash('sha1').update(data).digest('hex').toUpperCase()
  if (actualSha !== header.sha1Hex) {
    throw new Error(
      `Manifest data SHA1 mismatch: got ${actualSha}, expected ${header.sha1Hex}`
    )
  }

  const dataReader = new BinaryReader(data)
  const meta = parseManifestMeta(dataReader)
  if (meta.bIsFileData) {
    throw new Error('Manifest declares bIsFileData=true (file-data build); not supported in v0a')
  }
  const chunks = parseChunkDataList(dataReader)
  const files = parseFileManifestList(dataReader)
  const customFields = parseCustomFields(dataReader)

  return { meta, chunks, files, customFields }
}

/* TODO(v0b): Once `manifest-client.ts` can download a real manifest, capture
 * one to `src/main/download/__fixtures__/real-manifest-sample.bin` and add a
 * smoke test that round-trips through `parseManifest`. Validates against a
 * real-world payload, not just synthetic round-trips. */
