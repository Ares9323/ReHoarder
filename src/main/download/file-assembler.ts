import { promises as fsp } from 'node:fs'
import * as path from 'node:path'
import { createHash } from 'node:crypto'
import type { FileManifestEntry } from './manifest-types'

/**
 * Minimal interface a `ChunkSource`-like object must expose for assembly.
 * `chunk-source.ts` implements it; tests can pass a stub.
 */
export interface ChunkProvider {
  get(chunk: { guid: string; rollingHash: string; sha1: string }): Promise<Buffer>
}

export interface AssembleFileResult {
  /** True if the file already existed on disk with the correct SHA1 and was untouched. */
  skipped: boolean
}

/**
 * Write a single file under `destPath` by concatenating the byte slices
 * declared in `entry.chunkParts`. Chunks are fetched serially from the
 * `ChunkProvider`. The file is written to `destPath + '.temp'` first and
 * atomically renamed only after SHA1 verification passes.
 *
 * If a file already exists at `destPath` with a matching SHA1, it is left
 * untouched and the result reports `skipped: true`.
 *
 * Throws when the assembled file's SHA1 disagrees with `entry.sha1`; in
 * that case the temp file is removed and `destPath` is left as it was.
 */
export async function assembleFile(
  entry: FileManifestEntry,
  source: ChunkProvider,
  destPath: string
): Promise<AssembleFileResult> {
  if (await alreadyValid(destPath, entry.sha1)) {
    return { skipped: true }
  }

  await fsp.mkdir(path.dirname(destPath), { recursive: true })
  const tempPath = destPath + '.temp'
  // Clear any stale temp from a prior aborted run.
  await fsp.rm(tempPath, { force: true })

  const handle = await fsp.open(tempPath, 'w')
  const hasher = createHash('sha1')
  try {
    for (const part of entry.chunkParts) {
      const payload = await source.get({
        guid: part.chunkGuid,
        rollingHash: '',
        sha1: ''
      })
      const slice = payload.subarray(part.offset, part.offset + part.size)
      await handle.write(slice)
      hasher.update(slice)
    }
  } finally {
    await handle.close()
  }

  const actual = hasher.digest('hex').toUpperCase()
  if (entry.sha1 && actual !== entry.sha1.toUpperCase()) {
    await fsp.rm(tempPath, { force: true })
    throw new Error(
      `File ${entry.filename} sha1 mismatch: got ${actual}, expected ${entry.sha1}`
    )
  }

  await fsp.rename(tempPath, destPath)
  return { skipped: false }
}

async function alreadyValid(destPath: string, expectedSha1: string): Promise<boolean> {
  if (!expectedSha1 || expectedSha1 === '0'.repeat(40)) return false
  let buf: Buffer
  try {
    buf = await fsp.readFile(destPath)
  } catch {
    return false
  }
  const actual = createHash('sha1').update(buf).digest('hex').toUpperCase()
  return actual === expectedSha1.toUpperCase()
}
