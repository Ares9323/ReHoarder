import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { promises as fsp } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { addToProject } from './projects-add-to'
import type { DownloadsRepo, DownloadRow } from './db/downloads-repo'

let tmp: string
beforeEach(async () => {
  tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'rehoarder-addto-'))
})
afterEach(async () => {
  await fsp.rm(tmp, { recursive: true, force: true })
})

/** Minimal repo stub exposing just `listAll`. */
function repoWith(rows: DownloadRow[]): DownloadsRepo {
  return { listAll: () => rows } as unknown as DownloadsRepo
}

function doneRow(destDir: string, engineVersion: string): DownloadRow {
  return {
    id: 'r1', source: 'fab', sourceId: 'abc', title: 'X', status: 'done',
    bytesDone: 0, bytesTotal: 0, filesDone: 0, filesTotal: 0,
    currentFile: null, destDir, engineVersion, installTargetPath: null,
    buildVersion: null, error: null, createdAt: 0, startedAt: 0, finishedAt: 1
  }
}

describe('addToProject engine guard', () => {
  it('refuses an older target project without touching the filesystem', async () => {
    const assetDir = path.join(tmp, 'asset')
    await fsp.mkdir(path.join(assetDir, 'data', 'Content'), { recursive: true })
    const projectDir = path.join(tmp, 'proj')
    await fsp.mkdir(projectDir, { recursive: true })
    await fsp.writeFile(path.join(projectDir, 'Proj.uproject'), '{}')

    const r = await addToProject(repoWith([doneRow(assetDir, '5.7')]), {
      source: 'fab', sourceId: 'abc', engineVersion: '5.7',
      targetEngineVersion: '5.6', projectDir, conflict: 'skip'
    })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/older/)
    // Guard fires before any copy: no Content/ created in the project.
    await expect(fsp.access(path.join(projectDir, 'Content'))).rejects.toThrow()
  })

  it('allows a newer-or-equal target project', async () => {
    const assetDir = path.join(tmp, 'asset')
    await fsp.mkdir(path.join(assetDir, 'data', 'Content', 'Pack'), { recursive: true })
    await fsp.writeFile(path.join(assetDir, 'data', 'Content', 'Pack', 'a.uasset'), 'x')
    const projectDir = path.join(tmp, 'proj')
    await fsp.mkdir(projectDir, { recursive: true })
    await fsp.writeFile(path.join(projectDir, 'Proj.uproject'), '{}')

    const r = await addToProject(repoWith([doneRow(assetDir, '5.7')]), {
      source: 'fab', sourceId: 'abc', engineVersion: '5.7',
      targetEngineVersion: '5.8', projectDir, conflict: 'skip'
    })
    expect(r.ok).toBe(true)
    expect(r.filesCopied).toBe(1)
  })
})

describe('addToProject vaultAssetDir mode (orphan vault assets)', () => {
  it('copies Content from vaultAssetDir with no matching downloads row', async () => {
    const assetDir = path.join(tmp, 'orphan-asset')
    await fsp.mkdir(path.join(assetDir, 'data', 'Content'), { recursive: true })
    await fsp.writeFile(path.join(assetDir, 'data', 'Content', 'Foo.uasset'), 'x')
    const projectDir = path.join(tmp, 'proj')
    await fsp.mkdir(projectDir, { recursive: true })
    await fsp.writeFile(path.join(projectDir, 'Proj.uproject'), '{}')

    // Empty repo: no downloads row exists for this asset at all. The engine
    // guard is independent of the lookup mode; here the asset's required
    // version is known and compatible with the target, so it passes normally.
    const r = await addToProject(repoWith([]), {
      source: 'fab', sourceId: 'does-not-exist', engineVersion: '5.7',
      targetEngineVersion: '5.8', projectDir, conflict: 'skip',
      vaultAssetDir: assetDir
    })
    expect(r.ok).toBe(true)
    expect(r.filesCopied).toBe(1)
    await expect(
      fsp.access(path.join(projectDir, 'Content', 'Foo.uasset'))
    ).resolves.toBeUndefined()
  })

  it('skips the engine guard when the asset engine version is unknown', async () => {
    const assetDir = path.join(tmp, 'unknown-engine-asset')
    await fsp.mkdir(path.join(assetDir, 'data', 'Content'), { recursive: true })
    await fsp.writeFile(path.join(assetDir, 'data', 'Content', 'Bar.uasset'), 'x')
    const projectDir = path.join(tmp, 'proj')
    await fsp.mkdir(projectDir, { recursive: true })
    await fsp.writeFile(path.join(projectDir, 'Proj.uproject'), '{}')

    // required (asset) engine version is unknown -> we can't verify
    // compatibility, so the guard must not block. Matches the Local Vault
    // UI, which shows an advisory warning instead of hard-blocking.
    const r = await addToProject(repoWith([]), {
      source: 'fab', sourceId: 'does-not-exist', engineVersion: null,
      targetEngineVersion: '5.6', projectDir, conflict: 'skip',
      vaultAssetDir: assetDir
    })
    expect(r.ok).toBe(true)
    expect(r.filesCopied).toBe(1)
    await expect(
      fsp.access(path.join(projectDir, 'Content', 'Bar.uasset'))
    ).resolves.toBeUndefined()
  })
})

describe('addToProject destination dispatch', () => {
  async function setup(): Promise<{ assetDir: string; projectDir: string }> {
    const assetDir = path.join(tmp, 'asset')
    await fsp.mkdir(path.join(assetDir, 'data', 'Content', 'Rocks'), { recursive: true })
    await fsp.writeFile(path.join(assetDir, 'data', 'Content', 'Rocks', 'a.uasset'), 'x')
    const projectDir = path.join(tmp, 'proj')
    await fsp.mkdir(projectDir, { recursive: true })
    await fsp.writeFile(path.join(projectDir, 'Proj.uproject'), '{}')
    return { assetDir, projectDir }
  }

  it('keeps the fast copy for the default destination and never relocates', async () => {
    const { assetDir, projectDir } = await setup()
    const relocate = vi.fn()
    const r = await addToProject(
      repoWith([]),
      {
        source: 'fab', sourceId: 'x', engineVersion: '5.4', targetEngineVersion: '5.4',
        projectDir, conflict: 'skip', vaultAssetDir: assetDir,
        destination: { mount: 'game', subfolder: '', rename: 'Rocks' }
      },
      relocate
    )
    expect(r.ok).toBe(true)
    expect(relocate).not.toHaveBeenCalled()
    await expect(
      fsp.access(path.join(projectDir, 'Content', 'Rocks', 'a.uasset'))
    ).resolves.toBeUndefined()
  })

  it('delegates a non-default destination with the resolved content dir and .uproject', async () => {
    const { assetDir, projectDir } = await setup()
    const relocate = vi.fn().mockResolvedValue({ ok: true, filesCopied: 7 })
    const r = await addToProject(
      repoWith([]),
      {
        source: 'fab', sourceId: 'x', engineVersion: '5.4', targetEngineVersion: '5.4',
        projectDir, conflict: 'overwrite', vaultAssetDir: assetDir,
        destination: { mount: 'game', subfolder: 'ThirdParty' }
      },
      relocate
    )
    expect(r).toEqual({ ok: true, filesCopied: 7 })
    expect(relocate).toHaveBeenCalledWith({
      sourceContentDir: path.join(assetDir, 'data', 'Content'),
      uprojectPath: path.join(projectDir, 'Proj.uproject')
    })
    // Nothing was merged by the fast path.
    await expect(fsp.access(path.join(projectDir, 'Content'))).rejects.toThrow()
  })

  it('runs the engine guard before relocating', async () => {
    const { assetDir, projectDir } = await setup()
    const relocate = vi.fn()
    const r = await addToProject(
      repoWith([]),
      {
        source: 'fab', sourceId: 'x', engineVersion: '5.6', targetEngineVersion: '5.4',
        projectDir, conflict: 'skip', vaultAssetDir: assetDir,
        destination: { mount: 'game', subfolder: 'ThirdParty' }
      },
      relocate
    )
    expect(r.ok).toBe(false)
    expect(relocate).not.toHaveBeenCalled()
  })

  it('fails cleanly when relocation is requested but unavailable', async () => {
    const { assetDir, projectDir } = await setup()
    const r = await addToProject(repoWith([]), {
      source: 'fab', sourceId: 'x', engineVersion: '5.4', targetEngineVersion: '5.4',
      projectDir, conflict: 'skip', vaultAssetDir: assetDir,
      destination: { mount: 'game', subfolder: 'ThirdParty' }
    })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/relocat/i)
  })
})
