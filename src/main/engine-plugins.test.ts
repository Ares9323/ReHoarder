import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fsp } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { copyPluginToProject, listEnginePluginsRich, marketplaceToWebUrl } from './engine-plugins'

describe('marketplaceToWebUrl', () => {
  it('maps a Fab launcher link to the Fab listing page', () => {
    expect(
      marketplaceToWebUrl(
        'com.epicgames.launcher://ue/Fab/product/82FC4B56-9857-4bf9-8b43-cfcb1935280a',
        'Component Sorter'
      )
    ).toBe('https://www.fab.com/listings/82fc4b56-9857-4bf9-8b43-cfcb1935280a')
  })

  it('falls back to a Fab search for old Marketplace ids', () => {
    for (const kind of ['content', 'product']) {
      expect(
        marketplaceToWebUrl(
          `com.epicgames.launcher://ue/marketplace/${kind}/9e895371fa3a471c87337860d6f341ff`,
          'Blueprint Assist'
        )
      ).toBe('https://www.fab.com/search?q=Blueprint%20Assist')
    }
  })

  it('keeps http(s) links and drops empty or unknown values', () => {
    expect(marketplaceToWebUrl('https://example.com/p', 'X')).toBe('https://example.com/p')
    expect(marketplaceToWebUrl('', 'X')).toBeNull()
    expect(marketplaceToWebUrl(undefined, 'X')).toBeNull()
    expect(marketplaceToWebUrl('file:///C:/x', 'X')).toBeNull()
  })
})

let tmp: string
let engineRoot: string
let pluginDir: string
let upluginPath: string
let projectDir: string

beforeEach(async () => {
  tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'rehoarder-engine-plugins-'))
  engineRoot = path.join(tmp, 'UE_5.7')
  pluginDir = path.join(engineRoot, 'Engine', 'Plugins', 'Marketplace', 'MyPlugin1cfad1b9f3ddV14')
  upluginPath = path.join(pluginDir, 'MyPlugin.uplugin')
  await fsp.mkdir(path.join(pluginDir, 'Binaries', 'Win64'), { recursive: true })
  await fsp.mkdir(path.join(pluginDir, 'Intermediate', 'Build'), { recursive: true })
  await fsp.writeFile(
    upluginPath,
    JSON.stringify({
      FriendlyName: 'My Plugin',
      DocsURL: 'https://docs.example/my-plugin',
      MarketplaceURL: 'com.epicgames.launcher://ue/Fab/product/82fc4b56-9857-4bf9-8b43-cfcb1935280a'
    })
  )
  await fsp.writeFile(path.join(pluginDir, 'Binaries', 'Win64', 'MyPlugin.dll'), 'dll')
  await fsp.writeFile(path.join(pluginDir, 'Intermediate', 'Build', 'junk.txt'), 'junk')

  projectDir = path.join(tmp, 'Projects', 'MyGame')
  await fsp.mkdir(projectDir, { recursive: true })
  await fsp.writeFile(path.join(projectDir, 'MyGame.uproject'), '{}')
})

afterEach(async () => {
  await fsp.rm(tmp, { recursive: true, force: true })
})

describe('listEnginePluginsRich URLs', () => {
  it('exposes the docs link and the Fab page of a plugin', async () => {
    const [p] = await listEnginePluginsRich(engineRoot)
    expect(p.docsUrl).toBe('https://docs.example/my-plugin')
    expect(p.marketplaceUrl).toBe('https://www.fab.com/listings/82fc4b56-9857-4bf9-8b43-cfcb1935280a')
  })
})

describe('copyPluginToProject', () => {
  it('creates Plugins/ and copies the plugin, named after its .uplugin, without Intermediate/', async () => {
    const r = await copyPluginToProject(upluginPath, projectDir, false)
    expect(r.ok).toBe(true)
    const dest = path.join(projectDir, 'Plugins', 'MyPlugin')
    expect(r.destDir).toBe(dest)
    await expect(fsp.stat(path.join(dest, 'MyPlugin.uplugin'))).resolves.toBeTruthy()
    await expect(fsp.stat(path.join(dest, 'Binaries', 'Win64', 'MyPlugin.dll'))).resolves.toBeTruthy()
    await expect(fsp.stat(path.join(dest, 'Intermediate'))).rejects.toThrow()
  })

  it('refuses an existing copy unless overwrite, then replaces it cleanly', async () => {
    const dest = path.join(projectDir, 'Plugins', 'MyPlugin')
    await fsp.mkdir(dest, { recursive: true })
    await fsp.writeFile(path.join(dest, 'stale.txt'), 'old')

    const refused = await copyPluginToProject(upluginPath, projectDir, false)
    expect(refused.ok).toBe(false)
    expect(refused.exists).toBe(true)

    const replaced = await copyPluginToProject(upluginPath, projectDir, true)
    expect(replaced.ok).toBe(true)
    await expect(fsp.stat(path.join(dest, 'stale.txt'))).rejects.toThrow()
    await expect(fsp.stat(path.join(dest, 'MyPlugin.uplugin'))).resolves.toBeTruthy()
  })

  it('treats a copy kept under the engine build-id folder name as the existing install', async () => {
    const oldDir = path.join(projectDir, 'Plugins', 'MyPlugin1cfad1b9f3ddV14')
    await fsp.mkdir(oldDir, { recursive: true })
    await fsp.writeFile(path.join(oldDir, 'MyPlugin.uplugin'), '{}')

    const refused = await copyPluginToProject(upluginPath, projectDir, false)
    expect(refused.exists).toBe(true)
    expect(refused.destDir).toBe(oldDir)

    const replaced = await copyPluginToProject(upluginPath, projectDir, true)
    expect(replaced.ok).toBe(true)
    expect(replaced.destDir).toBe(path.join(projectDir, 'Plugins', 'MyPlugin'))
    await expect(fsp.stat(oldDir)).rejects.toThrow()
  })

  it('refuses a folder that is not an Unreal project', async () => {
    const notProject = path.join(tmp, 'NotAProject')
    await fsp.mkdir(notProject)
    const r = await copyPluginToProject(upluginPath, notProject, false)
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/No \.uproject/)
  })
})
