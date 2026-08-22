import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fsp } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { resolveVaultEngineVersion } from './vault-engine-version'

const MAGIC = 0x9e2a83c1

/** Same synthetic-header builder used by uasset-version.test.ts. */
function buildHeader(opts: { legacy: number; ue3?: number; ue4: number; ue5?: number }): Buffer {
  const hasUe5Field = opts.legacy <= -8
  const buf = Buffer.alloc(hasUe5Field ? 20 : 16)
  buf.writeUInt32LE(MAGIC, 0)
  buf.writeInt32LE(opts.legacy, 4)
  buf.writeInt32LE(opts.ue3 ?? 0, 8)
  buf.writeInt32LE(opts.ue4, 12)
  if (hasUe5Field) buf.writeInt32LE(opts.ue5 ?? 0, 16)
  return buf
}

let dir: string
beforeEach(async () => {
  dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'rehoarder-vault-engine-version-'))
})
afterEach(async () => {
  await fsp.rm(dir, { recursive: true, force: true })
})

describe('resolveVaultEngineVersion', () => {
  it('reads EngineAssociation from a .uproject under data/ for kind=project', async () => {
    await fsp.mkdir(path.join(dir, 'data'), { recursive: true })
    await fsp.writeFile(
      path.join(dir, 'data', 'SomeProject.uproject'),
      JSON.stringify({ EngineAssociation: '5.4' })
    )

    const result = await resolveVaultEngineVersion(dir, 'project')
    expect(result).toBe('5.4')
  })

  it('infers the engine version from a .uasset header under data/ for kind=asset', async () => {
    const contentDir = path.join(dir, 'data', 'Content')
    await fsp.mkdir(contentDir, { recursive: true })
    const header = buildHeader({ legacy: -8, ue4: 522, ue5: 1012 })
    await fsp.writeFile(path.join(contentDir, 'x.uasset'), header)

    const result = await resolveVaultEngineVersion(dir, 'asset')
    expect(result).toBe('5.4')
  })

  it('returns null for an empty asset dir', async () => {
    await fsp.mkdir(path.join(dir, 'data'), { recursive: true })
    const result = await resolveVaultEngineVersion(dir, 'asset')
    expect(result).toBeNull()
  })

  it('returns null for a project .uproject with a GUID EngineAssociation, falling through to content scan', async () => {
    await fsp.mkdir(path.join(dir, 'data'), { recursive: true })
    await fsp.writeFile(
      path.join(dir, 'data', 'SomeProject.uproject'),
      JSON.stringify({ EngineAssociation: '{12345678-1234-1234-1234-123456789012}' })
    )
    const result = await resolveVaultEngineVersion(dir, 'project')
    expect(result).toBeNull()
  })

  it('falls back to <assetDir> directly when data/ is absent', async () => {
    const contentDir = path.join(dir, 'Content')
    await fsp.mkdir(contentDir, { recursive: true })
    const header = buildHeader({ legacy: -8, ue4: 522, ue5: 1012 })
    await fsp.writeFile(path.join(contentDir, 'x.uasset'), header)

    const result = await resolveVaultEngineVersion(dir, 'asset')
    expect(result).toBe('5.4')
  })

  it('never throws for a nonexistent directory', async () => {
    const result = await resolveVaultEngineVersion(path.join(dir, 'does-not-exist'), 'asset')
    expect(result).toBeNull()
  })
})
