import { promises as fsp } from 'node:fs'
import * as path from 'node:path'

/** Unreal package file tag, little-endian on disk as `c1 83 2a 9e`. */
const UASSET_MAGIC = 0x9e2a83c1

/** Bytes needed to read the full UE5-era header (tag..FileVersionUE5). */
const HEADER_READ_SIZE = 24

const HEADER_EXTENSIONS = new Set(['.uasset', '.umap'])

/**
 * Infer the engine version floor from a `.uasset`/`.umap` file header.
 *
 * Little-endian layout, offsets from the start of the file:
 *  0  tag (uint32)              == 0x9E2A83C1
 *  4  legacyFileVersion (int32)
 *  8  legacyUE3Version (int32)
 * 12  FileVersionUE4 (int32)
 * 16  FileVersionUE5 (int32)    — only present when legacyFileVersion <= -8
 *
 * Returns `null` when the buffer is too short, the magic doesn't match, or
 * the version isn't mappable to a known engine floor.
 */
export function inferEngineVersionFromHeader(buf: Buffer): string | null {
  if (buf.length < 16) return null
  if (buf.readUInt32LE(0) !== UASSET_MAGIC) return null

  const legacyFileVersion = buf.readInt32LE(4)
  const fileVersionUE4 = buf.readInt32LE(12)
  const needsUe5Field = legacyFileVersion <= -8
  if (needsUe5Field && buf.length < 20) return null
  const fileVersionUE5 = needsUe5Field ? buf.readInt32LE(16) : 0

  return mapToEngineVersion(fileVersionUE4, fileVersionUE5)
}

function mapToEngineVersion(ue4: number, ue5: number): string | null {
  if (ue5 >= 1018) return '5.7'
  if (ue5 >= 1017) return '5.6'
  if (ue5 >= 1013) return '5.5'
  if (ue5 >= 1012) return '5.4'
  if (ue5 >= 1009) return '5.2'
  if (ue5 >= 1008) return '5.1'
  if (ue5 >= 1004) return '5.0'
  if (ue5 >= 1000) return '5.0'
  if (ue5 === 0) {
    if (ue4 >= 522) return '4.27'
    return null
  }
  return null
}

/**
 * Recursively walk `dir` looking for `.uasset`/`.umap` files, reading only
 * the first ~24 bytes of each to infer the engine version from its header.
 * Returns the first inferable version found, or `null` if none. Bounded by
 * `maxFiles` (headers actually read) and a fixed recursion depth so a huge
 * or malformed tree can't cause runaway work. Never throws — unreadable
 * files/directories are silently skipped.
 */
export async function findEngineVersionInContent(
  dir: string,
  maxFiles = 64
): Promise<string | null> {
  const state = { filesRead: 0 }
  return walkDir(dir, 0, maxFiles, state)
}

const MAX_DEPTH = 24

async function walkDir(
  dir: string,
  depth: number,
  maxFiles: number,
  state: { filesRead: number }
): Promise<string | null> {
  if (depth > MAX_DEPTH) return null
  if (state.filesRead >= maxFiles) return null

  let entries: import('node:fs').Dirent[]
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true })
  } catch {
    return null
  }

  const subdirs: string[] = []

  for (const entry of entries) {
    if (state.filesRead >= maxFiles) return null
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      subdirs.push(full)
      continue
    }
    if (!entry.isFile()) continue
    if (!HEADER_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue

    state.filesRead += 1
    const version = await readHeaderVersion(full)
    if (version) return version
  }

  for (const sub of subdirs) {
    const version = await walkDir(sub, depth + 1, maxFiles, state)
    if (version) return version
  }

  return null
}

async function readHeaderVersion(filePath: string): Promise<string | null> {
  let handle: fsp.FileHandle | undefined
  try {
    handle = await fsp.open(filePath, 'r')
    const buf = Buffer.alloc(HEADER_READ_SIZE)
    const { bytesRead } = await handle.read(buf, 0, HEADER_READ_SIZE, 0)
    return inferEngineVersionFromHeader(buf.subarray(0, bytesRead))
  } catch {
    return null
  } finally {
    await handle?.close().catch(() => {})
  }
}
