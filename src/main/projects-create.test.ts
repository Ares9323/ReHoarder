import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fsp } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { createProjectFromVault } from './projects-create'
import type { DownloadsRepo, DownloadRow } from './db/downloads-repo'

let tmp: string
beforeEach(async () => {
  tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'rehoarder-create-'))
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

describe('createProjectFromVault (downloads-row mode)', () => {
  it('materialises a project from a matching downloads row', async () => {
    const assetDir = path.join(tmp, 'asset')
    await fsp.mkdir(path.join(assetDir, 'data'), { recursive: true })
    await fsp.writeFile(path.join(assetDir, 'data', 'MyProj.uproject'), '{}')
    await fsp.writeFile(path.join(assetDir, 'data', 'note.txt'), 'hi')
    const parentDir = path.join(tmp, 'projects')
    await fsp.mkdir(parentDir, { recursive: true })

    const r = await createProjectFromVault(repoWith([doneRow(assetDir, '5.7')]), {
      source: 'fab', sourceId: 'abc', engineVersion: '5.7',
      name: 'NewProj', parentDir
    })
    expect(r.ok).toBe(true)
    expect(r.uprojectPath).toBe(path.join(parentDir, 'NewProj', 'NewProj.uproject'))
    await expect(fsp.access(r.uprojectPath as string)).resolves.toBeUndefined()
  })
})

describe('createProjectFromVault vaultAssetDir mode (orphan vault assets)', () => {
  it('materialises a project from vaultAssetDir with no matching downloads row', async () => {
    const assetDir = path.join(tmp, 'orphan-asset')
    await fsp.mkdir(path.join(assetDir, 'data'), { recursive: true })
    await fsp.writeFile(path.join(assetDir, 'data', 'MyProj.uproject'), '{}')
    await fsp.writeFile(path.join(assetDir, 'data', 'note.txt'), 'hi')
    const parentDir = path.join(tmp, 'projects')
    await fsp.mkdir(parentDir, { recursive: true })

    // Empty repo: no downloads row exists for this asset at all.
    const r = await createProjectFromVault(repoWith([]), {
      source: 'fab', sourceId: 'does-not-exist', engineVersion: null,
      name: 'OrphanProj', parentDir,
      vaultAssetDir: assetDir
    })
    expect(r.ok).toBe(true)
    expect(r.uprojectPath).toBe(path.join(parentDir, 'OrphanProj', 'OrphanProj.uproject'))
    await expect(fsp.access(r.uprojectPath as string)).resolves.toBeUndefined()
    await expect(
      fsp.access(path.join(parentDir, 'OrphanProj', 'note.txt'))
    ).resolves.toBeUndefined()
  })
})
