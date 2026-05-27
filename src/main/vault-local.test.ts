import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fsp } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { listLocalVault } from './vault-local'

/**
 * Spin up a throwaway directory layout mirroring what the chunk assembler
 * writes under a vault root — one entry per top-level subdirectory, each
 * with an optional `data/` payload that the kind-detection logic inspects.
 */
let root: string

beforeEach(async () => {
  root = await fsp.mkdtemp(path.join(os.tmpdir(), 'rehoarder-vault-'))
})

afterEach(async () => {
  await fsp.rm(root, { recursive: true, force: true })
})

async function seedEntry(
  name: string,
  layout: 'asset' | 'asset-with-config' | 'asset-with-platforms' | 'plugin' | 'plugin-with-content' | 'empty' | 'no-data'
): Promise<void> {
  const entry = path.join(root, name)
  await fsp.mkdir(entry, { recursive: true })
  if (layout === 'no-data') return
  const dataDir = path.join(entry, 'data')
  await fsp.mkdir(dataDir, { recursive: true })
  switch (layout) {
    case 'asset': {
      await fsp.mkdir(path.join(dataDir, 'Content', 'Pack'), { recursive: true })
      await fsp.writeFile(path.join(dataDir, 'Content', 'Pack', 'a.uasset'), 'x')
      break
    }
    case 'asset-with-config': {
      await fsp.mkdir(path.join(dataDir, 'Content', 'Pack'), { recursive: true })
      await fsp.writeFile(path.join(dataDir, 'Content', 'Pack', 'a.uasset'), 'x')
      await fsp.mkdir(path.join(dataDir, 'Config'), { recursive: true })
      await fsp.writeFile(path.join(dataDir, 'Config', 'DefaultGame.ini'), '[/Script/Engine]')
      break
    }
    case 'asset-with-platforms': {
      await fsp.mkdir(path.join(dataDir, 'Content', 'Pack'), { recursive: true })
      await fsp.writeFile(path.join(dataDir, 'Content', 'Pack', 'a.uasset'), 'x')
      await fsp.mkdir(path.join(dataDir, 'Platforms', 'Windows'), { recursive: true })
      await fsp.writeFile(path.join(dataDir, 'Platforms', 'Windows', 'bin.dll'), 'x')
      break
    }
    case 'plugin': {
      const pluginDir = path.join(dataDir, 'Engine', 'Plugins', 'Marketplace', 'MyPlugin')
      await fsp.mkdir(pluginDir, { recursive: true })
      await fsp.writeFile(path.join(pluginDir, 'MyPlugin.uplugin'), '{}')
      break
    }
    case 'plugin-with-content': {
      // Engine plugins can ship demo Content/ — kind should still report `plugin`
      // because the Add-to-project flow doesn't apply to plugin payloads.
      const pluginDir = path.join(dataDir, 'Engine', 'Plugins', 'Marketplace', 'MyPlugin')
      await fsp.mkdir(pluginDir, { recursive: true })
      await fsp.writeFile(path.join(pluginDir, 'MyPlugin.uplugin'), '{}')
      await fsp.mkdir(path.join(dataDir, 'Content', 'Demo'), { recursive: true })
      await fsp.writeFile(path.join(dataDir, 'Content', 'Demo', 'demo.uasset'), 'x')
      break
    }
    case 'empty': {
      // `data/` exists but has no recognisable children.
      break
    }
  }
}

describe('listLocalVault — kind detection', () => {
  it('classifies a Content-only payload as asset', async () => {
    await seedEntry('AssetPack', 'asset')
    const entries = await listLocalVault([root])
    expect(entries).toHaveLength(1)
    expect(entries[0].kind).toBe('asset')
    expect(entries[0].hasData).toBe(true)
  })

  it('treats Config sibling next to Content as still an asset', async () => {
    await seedEntry('AssetWithConfig', 'asset-with-config')
    const entries = await listLocalVault([root])
    expect(entries[0].kind).toBe('asset')
  })

  it('treats Platforms sibling next to Content as still an asset', async () => {
    await seedEntry('AssetWithPlatforms', 'asset-with-platforms')
    const entries = await listLocalVault([root])
    expect(entries[0].kind).toBe('asset')
  })

  it('classifies Engine/Plugins/Marketplace/<n>/<n>.uplugin payload as plugin', async () => {
    await seedEntry('SomePlugin_5.3', 'plugin')
    const entries = await listLocalVault([root])
    expect(entries[0].kind).toBe('plugin')
  })

  it('classifies plugin + demo Content as plugin (Engine wins)', async () => {
    await seedEntry('PluginWithDemo', 'plugin-with-content')
    const entries = await listLocalVault([root])
    expect(entries[0].kind).toBe('plugin')
  })

  it('reports unknown for a data/ folder with neither Content nor Engine', async () => {
    await seedEntry('Empty', 'empty')
    const entries = await listLocalVault([root])
    expect(entries[0].kind).toBe('unknown')
    expect(entries[0].hasData).toBe(true)
  })

  it('reports unknown for an entry that never produced a data/ folder', async () => {
    await seedEntry('Interrupted', 'no-data')
    const entries = await listLocalVault([root])
    expect(entries[0].kind).toBe('unknown')
    expect(entries[0].hasData).toBe(false)
  })

  it('leaves source/sourceId/engineVersion null for the on-disk scanner (IPC layer fills them)', async () => {
    await seedEntry('AssetPack', 'asset')
    const entries = await listLocalVault([root])
    expect(entries[0].source).toBeNull()
    expect(entries[0].sourceId).toBeNull()
    expect(entries[0].engineVersion).toBeNull()
  })
})
