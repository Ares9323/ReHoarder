import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fsp } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  inferEngineVersionFromHeader,
  findEngineVersionInContent,
} from './uasset-version'

const MAGIC = 0x9e2a83c1

/**
 * Build a synthetic `.uasset`/`.umap` header matching the real on-disk
 * layout: tag, legacyFileVersion, legacyUE3Version, FileVersionUE4, and
 * (for UE5-era files) FileVersionUE5.
 */
function buildHeader(opts: {
  legacy: number
  ue3?: number
  ue4: number
  ue5?: number
}): Buffer {
  const hasUe5Field = opts.legacy <= -8
  const buf = Buffer.alloc(hasUe5Field ? 20 : 16)
  buf.writeUInt32LE(MAGIC, 0)
  buf.writeInt32LE(opts.legacy, 4)
  buf.writeInt32LE(opts.ue3 ?? 0, 8)
  buf.writeInt32LE(opts.ue4, 12)
  if (hasUe5Field) buf.writeInt32LE(opts.ue5 ?? 0, 16)
  return buf
}

describe('inferEngineVersionFromHeader', () => {
  it('infers 5.1 from the real AlienPor BP_portal.uasset header values', () => {
    const buf = buildHeader({ legacy: -8, ue3: 864, ue4: 522, ue5: 1008 })
    expect(inferEngineVersionFromHeader(buf)).toBe('5.1')
  })

  it('infers 5.7 for ue5 >= 1018', () => {
    const buf = buildHeader({ legacy: -8, ue4: 522, ue5: 1018 })
    expect(inferEngineVersionFromHeader(buf)).toBe('5.7')
  })

  it('infers 5.6 for ue5 == 1017', () => {
    const buf = buildHeader({ legacy: -8, ue4: 522, ue5: 1017 })
    expect(inferEngineVersionFromHeader(buf)).toBe('5.6')
  })

  it('infers 5.5 for ue5 == 1013', () => {
    const buf = buildHeader({ legacy: -8, ue4: 522, ue5: 1013 })
    expect(inferEngineVersionFromHeader(buf)).toBe('5.5')
  })

  it('infers 5.4 for ue5 == 1012', () => {
    const buf = buildHeader({ legacy: -8, ue4: 522, ue5: 1012 })
    expect(inferEngineVersionFromHeader(buf)).toBe('5.4')
  })

  it('infers 5.2 for ue5 == 1009', () => {
    const buf = buildHeader({ legacy: -8, ue4: 522, ue5: 1009 })
    expect(inferEngineVersionFromHeader(buf)).toBe('5.2')
  })

  it('infers 5.0 for ue5 == 1004', () => {
    const buf = buildHeader({ legacy: -8, ue4: 522, ue5: 1004 })
    expect(inferEngineVersionFromHeader(buf)).toBe('5.0')
  })

  it('infers 4.27 for legacy -7 (UE4-era, no ue5 field)', () => {
    const buf = buildHeader({ legacy: -7, ue4: 522 })
    expect(buf.length).toBe(16)
    expect(inferEngineVersionFromHeader(buf)).toBe('4.27')
  })

  it('returns null for wrong magic', () => {
    const buf = Buffer.alloc(20)
    buf.writeUInt32LE(0x12345678, 0)
    buf.writeInt32LE(-8, 4)
    buf.writeInt32LE(0, 8)
    buf.writeInt32LE(522, 12)
    buf.writeInt32LE(1008, 16)
    expect(inferEngineVersionFromHeader(buf)).toBeNull()
  })

  it('returns null for a buffer shorter than 20 bytes', () => {
    const buf = Buffer.alloc(19)
    buf.writeUInt32LE(MAGIC, 0)
    expect(inferEngineVersionFromHeader(buf)).toBeNull()
  })
})

describe('findEngineVersionInContent', () => {
  let root: string

  beforeEach(async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), 'rehoarder-uasset-'))
  })

  afterEach(async () => {
    await fsp.rm(root, { recursive: true, force: true })
  })

  it('finds the engine version from a nested .uasset file', async () => {
    const nested = path.join(root, 'Content', 'Pack')
    await fsp.mkdir(nested, { recursive: true })
    const header = buildHeader({ legacy: -8, ue3: 864, ue4: 522, ue5: 1008 })
    const padded = Buffer.concat([header, Buffer.alloc(100)])
    await fsp.writeFile(path.join(nested, 'BP_portal.uasset'), padded)

    const result = await findEngineVersionInContent(root)
    expect(result).toBe('5.1')
  })

  it('returns null for an empty directory', async () => {
    const result = await findEngineVersionInContent(root)
    expect(result).toBeNull()
  })
})
