import { describe, it, expect } from 'vitest'
import * as path from 'node:path'
import { resolveReportedAssetDir } from './download-orchestrator'

// `resolveReportedAssetDir` computes the path ReHoarder persists as a download's
// `destDir` — the folder the Downloads-tab "Open" button reveals. For plain
// assets that's `<vaultDir>/<subdir>`. For plugin installs (engine-route /
// project-install, which write straight from the manifest with no `data/`
// wrapper) it must be the folder that actually holds the `.uplugin`, NOT the
// engine root or the project's `Plugins` parent.

describe('resolveReportedAssetDir', () => {
  it('returns <vaultDir>/<subdir> for a normal wrapped asset', () => {
    const dir = resolveReportedAssetDir([{ filename: 'Content/Foo.uasset' }], {
      vaultDir: path.join('D:', 'Vault'),
      subdir: 'MyAsset_artifactId',
      noWrapDataDir: false
    })
    expect(dir).toBe(path.join('D:', 'Vault', 'MyAsset_artifactId'))
  })

  it('opens the .uplugin folder, not the engine root, for an engine-route install', () => {
    const engineRoot = path.join('C:', 'Program Files', 'Epic Games', 'UE_5.7')
    const dir = resolveReportedAssetDir(
      [
        { filename: 'Engine/Plugins/Marketplace/NineSlic45562530d472V7/NineSlicer.uplugin' },
        { filename: 'Engine/Plugins/Marketplace/NineSlic45562530d472V7/Source/Foo.cpp' }
      ],
      { vaultDir: engineRoot, subdir: '', noWrapDataDir: true }
    )
    expect(dir).toBe(
      path.join(engineRoot, 'Engine', 'Plugins', 'Marketplace', 'NineSlic45562530d472V7')
    )
  })

  it('opens the .uplugin folder, not Plugins parent, for a project install (prefix stripped)', () => {
    const pluginsDir = path.join('D:', 'Projects', 'MyGame', 'Plugins')
    const dir = resolveReportedAssetDir(
      [
        { filename: 'Engine/Plugins/Marketplace/NineSlic45562530d472V7/NineSlicer.uplugin' },
        { filename: 'Engine/Plugins/Marketplace/NineSlic45562530d472V7/Resources/Icon.png' }
      ],
      {
        vaultDir: pluginsDir,
        subdir: '',
        noWrapDataDir: true,
        pathStripPrefix: 'Engine/Plugins/Marketplace/'
      }
    )
    expect(dir).toBe(path.join(pluginsDir, 'NineSlic45562530d472V7'))
  })

  it('picks the top-level .uplugin when a nested sub-plugin also ships one', () => {
    const engineRoot = path.join('C:', 'UE')
    const dir = resolveReportedAssetDir(
      [
        { filename: 'Engine/Plugins/Marketplace/Mega/Source/Foo.cpp' },
        { filename: 'Engine/Plugins/Marketplace/Mega/Plugins/Sub/Sub.uplugin' },
        { filename: 'Engine/Plugins/Marketplace/Mega/Mega.uplugin' }
      ],
      { vaultDir: engineRoot, subdir: '', noWrapDataDir: true }
    )
    expect(dir).toBe(path.join(engineRoot, 'Engine', 'Plugins', 'Marketplace', 'Mega'))
  })

  it('falls back to the base dir for a no-wrap install with no .uplugin', () => {
    const engineRoot = path.join('C:', 'UE')
    const dir = resolveReportedAssetDir([{ filename: 'Engine/Plugins/Marketplace/X/data.bin' }], {
      vaultDir: engineRoot,
      subdir: '',
      noWrapDataDir: true
    })
    expect(dir).toBe(engineRoot)
  })
})
