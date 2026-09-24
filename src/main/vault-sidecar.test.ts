import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fsp } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { readSidecar, writeSidecar, SIDECAR_FILENAME } from './vault-sidecar'

let dir: string
beforeEach(async () => {
  dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'rehoarder-sidecar-'))
})
afterEach(async () => {
  await fsp.rm(dir, { recursive: true, force: true })
})

describe('writeSidecar / readSidecar', () => {
  it('round-trips a written sidecar', async () => {
    const ok = await writeSidecar(dir, {
      source: 'fab',
      sourceId: 'abc123',
      engineVersion: '5.7',
      buildVersion: '5.7.0-1+++x',
      title: 'Beach Life',
      kind: 'asset',
      fabDistributionMethod: 'ASSET_PACK',
      downloadedAt: 1755790086000
    })
    expect(ok).toBe(true)
    const read = await readSidecar(dir)
    expect(read).toEqual({
      version: 1,
      type: 'vault-asset',
      source: 'fab',
      sourceId: 'abc123',
      engineVersion: '5.7',
      buildVersion: '5.7.0-1+++x',
      title: 'Beach Life',
      kind: 'asset',
      fabDistributionMethod: 'ASSET_PACK',
      downloadedAt: 1755790086000
    })
  })

  it('round-trips a sidecar with null source/sourceId (orphan asset)', async () => {
    const ok = await writeSidecar(dir, {
      source: null,
      sourceId: null,
      engineVersion: '5.4',
      buildVersion: null,
      title: null,
      kind: 'asset',
      fabDistributionMethod: null,
      downloadedAt: 1755790086000
    })
    expect(ok).toBe(true)
    const read = await readSidecar(dir)
    expect(read).toEqual({
      version: 1,
      type: 'vault-asset',
      source: null,
      sourceId: null,
      engineVersion: '5.4',
      buildVersion: null,
      title: null,
      kind: 'asset',
      fabDistributionMethod: null,
      downloadedAt: 1755790086000
    })
  })

  it('writes to <assetDir>/.rehoarder.json', async () => {
    await writeSidecar(dir, {
      source: 'fab', sourceId: 'x', engineVersion: null, buildVersion: null, title: null,
      kind: 'project', fabDistributionMethod: null, downloadedAt: 1
    })
    const raw = await fsp.readFile(path.join(dir, SIDECAR_FILENAME), 'utf-8')
    expect(JSON.parse(raw).kind).toBe('project')
  })

  it('returns null when no sidecar exists', async () => {
    expect(await readSidecar(dir)).toBeNull()
  })

  it('returns null on invalid JSON', async () => {
    await fsp.writeFile(path.join(dir, SIDECAR_FILENAME), '{ not json', 'utf-8')
    expect(await readSidecar(dir)).toBeNull()
  })

  it('returns null on an unknown version', async () => {
    await fsp.writeFile(
      path.join(dir, SIDECAR_FILENAME),
      JSON.stringify({ version: 999, kind: 'asset' }),
      'utf-8'
    )
    expect(await readSidecar(dir)).toBeNull()
  })

  it('stamps type: vault-asset on write', async () => {
    await writeSidecar(dir, {
      source: 'fab', sourceId: 'x', engineVersion: null, buildVersion: null, title: null,
      kind: 'project', fabDistributionMethod: null, downloadedAt: 1
    })
    const raw = await fsp.readFile(path.join(dir, SIDECAR_FILENAME), 'utf-8')
    expect(JSON.parse(raw).type).toBe('vault-asset')
  })

  it('reads a pre-buildVersion sidecar as buildVersion null', async () => {
    await fsp.writeFile(
      path.join(dir, SIDECAR_FILENAME),
      JSON.stringify({
        version: 1,
        type: 'vault-asset',
        source: 'fab',
        sourceId: 'old',
        engineVersion: '5.3',
        title: 'Old',
        kind: 'asset',
        fabDistributionMethod: null,
        downloadedAt: 1
      }),
      'utf-8'
    )
    expect((await readSidecar(dir))?.buildVersion).toBeNull()
  })

  it('rejects a project marker (no type field) shaped payload', async () => {
    // Same filename/version as a vault sidecar but written by
    // createProjectFromVault (src/main/projects-create.ts) into a created
    // project root — must not be misread as a vault sidecar.
    await fsp.writeFile(
      path.join(dir, SIDECAR_FILENAME),
      JSON.stringify({
        version: 1,
        source: 'fab',
        sourceId: 'abc123',
        engineVersion: '5.7',
        createdAt: Date.now()
      }),
      'utf-8'
    )
    expect(await readSidecar(dir)).toBeNull()
  })
})
