import { inflateSync } from 'node:zlib'
import { createHash } from 'node:crypto'
import { BinaryReader } from './binary-reader'
import { parseManifestHeader } from './parse-manifest-header'
import { parseManifestMeta } from './parse-manifest-meta'
import { parseChunkDataList } from './parse-chunk-data-list'
import { parseFileManifestList } from './parse-file-manifest-list'
import { parseCustomFields } from './parse-custom-fields'
import type { Manifest, ChunkInfo, FileManifestEntry, ChunkPart } from './manifest-types'

const JSON_OPEN_BRACE = 0x7b

/**
 * Parse an Epic Chunked Manifest blob (Fab CDN payload) into a typed
 * `Manifest` object. Auto-detects between the binary chunked format
 * (magic `0x44BEC00C`) and the legacy JSON format (UE 4.x marketplace
 * assets, blob starts with `{`).
 *
 * Throws on magic mismatch, encryption, decompression mismatch, or SHA1
 * mismatch of the uncompressed data section.
 */
export function parseManifest(buf: Buffer): Manifest {
  if (buf.length > 0 && buf[0] === JSON_OPEN_BRACE) {
    return parseManifestJson(buf)
  }
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

/* ------------------------------------------------------------------ */
/*  JSON manifest path (legacy UE 4.x marketplace assets)             */
/* ------------------------------------------------------------------ */
/*
 * The JSON manifest encodes numeric fields as ASCII strings of decimal
 * bytes in LE order. For example "127020001000" expands to four bytes
 * [127, 20, 1, 0], which read as uint32 LE = 0x00011477 = 66167.
 *
 * Hashes are encoded the same way but with 20 (SHA1) or 8 (Poly64) bytes.
 *
 * The Poly64 rolling hash (a uint64) is decoded LE and re-emitted as
 * 16-char uppercase hex to match what the binary path produces.
 */

interface JsonChunkPart {
  Guid: string
  Offset: string
  Size: string
}

interface JsonFileEntry {
  Filename: string
  FileHash: string
  FileChunkParts: JsonChunkPart[]
  SymlinkTarget?: string
}

interface JsonManifest {
  ManifestFileVersion: string | number
  bIsFileData: boolean
  AppID: string
  AppNameString: string
  BuildVersionString: string
  LaunchExeString?: string
  LaunchCommand?: string
  PrereqIds?: string[]
  PrereqName?: string
  PrereqPath?: string
  PrereqArgs?: string
  FileManifestList: JsonFileEntry[]
  ChunkHashList: Record<string, string>
  ChunkShaList: Record<string, string>
  DataGroupList: Record<string, string>
  ChunkFilesizeList: Record<string, string>
  CustomFields?: Record<string, string>
}

function decodeDecLEBytes(s: string): Buffer {
  if (s.length % 3 !== 0) {
    throw new Error(
      `JSON manifest numeric field has invalid length ${s.length} (expected multiple of 3): "${s}"`
    )
  }
  const out = Buffer.alloc(s.length / 3)
  for (let i = 0; i < out.length; i++) {
    const n = parseInt(s.slice(i * 3, i * 3 + 3), 10)
    if (Number.isNaN(n) || n < 0 || n > 255) {
      throw new Error(
        `JSON manifest numeric field has invalid byte at offset ${i}: "${s.slice(i * 3, i * 3 + 3)}"`
      )
    }
    out[i] = n
  }
  return out
}

function decodeUint32(s: string): number {
  if (s.length !== 12) {
    throw new Error(`JSON manifest uint32 expected 12 chars, got ${s.length}: "${s}"`)
  }
  return decodeDecLEBytes(s).readUInt32LE(0)
}

function decodeUint64(s: string): bigint {
  if (s.length !== 24) {
    throw new Error(`JSON manifest uint64 expected 24 chars, got ${s.length}: "${s}"`)
  }
  return decodeDecLEBytes(s).readBigUInt64LE(0)
}

function decodeUint8(s: string): number {
  if (s.length !== 3) {
    throw new Error(`JSON manifest uint8 expected 3 chars, got ${s.length}: "${s}"`)
  }
  const n = parseInt(s, 10)
  if (Number.isNaN(n) || n < 0 || n > 255) {
    throw new Error(`JSON manifest uint8 out of range: "${s}"`)
  }
  return n
}

/** SHA1 hash encoded as 60 chars (20 decimal triplets LE). Returns 40-char hex uppercase. */
function decodeSha1(s: string): string {
  if (s.length !== 60) {
    throw new Error(`JSON manifest SHA1 expected 60 chars, got ${s.length}: "${s}"`)
  }
  return decodeDecLEBytes(s).toString('hex').toUpperCase()
}

/** Poly64 rolling hash encoded as 24 chars (8 decimal triplets LE). Returns 16-char hex uppercase. */
function decodePoly64(s: string): string {
  return decodeUint64(s).toString(16).toUpperCase().padStart(16, '0')
}

export function parseManifestJson(buf: Buffer): Manifest {
  const text = buf.toString('utf-8')
  let data: JsonManifest
  try {
    data = JSON.parse(text) as JsonManifest
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new Error(`JSON manifest parse failed: ${msg}`)
  }

  if (data.bIsFileData) {
    throw new Error('JSON manifest declares bIsFileData=true; not supported')
  }

  const featureLevel = typeof data.ManifestFileVersion === 'number'
    ? data.ManifestFileVersion
    : decodeUint32(data.ManifestFileVersion)
  const appId = decodeUint32(data.AppID)

  const chunks: ChunkInfo[] = []
  for (const [guid, hashStr] of Object.entries(data.ChunkHashList)) {
    const sha1 = data.ChunkShaList[guid] ?? ''
    const dg = data.DataGroupList[guid] ?? '000'
    const sizeStr = data.ChunkFilesizeList[guid] ?? '0'.repeat(24)
    chunks.push({
      guid: guid.toUpperCase(),
      rollingHash: decodePoly64(hashStr),
      sha1: sha1.toUpperCase(),
      groupNumber: decodeUint8(dg),
      windowSize: 1048576,
      fileSize: Number(decodeUint64(sizeStr))
    })
  }

  const files: FileManifestEntry[] = data.FileManifestList.map((entry) => {
    const chunkParts: ChunkPart[] = entry.FileChunkParts.map((part) => ({
      chunkGuid: part.Guid.toUpperCase(),
      offset: decodeUint32(part.Offset),
      size: decodeUint32(part.Size)
    }))
    const fileSize = chunkParts.reduce((acc, p) => acc + p.size, 0)
    return {
      filename: entry.Filename,
      symlinkTarget: entry.SymlinkTarget ?? '',
      sha1: decodeSha1(entry.FileHash),
      fileMetaFlags: 0,
      installTags: [],
      chunkParts,
      fileSize
    }
  })

  return {
    meta: {
      featureLevel,
      bIsFileData: false,
      appId,
      appName: data.AppNameString,
      buildVersion: data.BuildVersionString,
      buildId: '',
      launchExe: data.LaunchExeString ?? '',
      launchCommand: data.LaunchCommand ?? '',
      prereqIds: data.PrereqIds ?? [],
      prereqName: data.PrereqName ?? '',
      prereqPath: data.PrereqPath ?? '',
      prereqArgs: data.PrereqArgs ?? '',
      uninstallExe: '',
      uninstallCommand: ''
    },
    chunks,
    files,
    customFields: data.CustomFields ?? {}
  }
}
