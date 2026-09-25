import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fsp } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  listTopLevelFolders,
  listLoosePackages,
  listContentPlugins,
  listProjectPluginNames,
  buildDestination,
  renderUproject,
  renderUpluginStub,
  renderRelocateScript,
  findScriptModules,
  listContentSubfolders,
  findPluginsForModules,
  type RelocatePlan
} from './projects-relocate-plan'

let tmp: string
beforeEach(async () => {
  tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'rehoarder-relplan-'))
})
afterEach(async () => {
  await fsp.rm(tmp, { recursive: true, force: true })
})

async function touch(p: string, content = 'x'): Promise<void> {
  await fsp.mkdir(path.dirname(p), { recursive: true })
  await fsp.writeFile(p, content)
}

describe('listTopLevelFolders / listLoosePackages', () => {
  it('lists folders sorted, skipping World Partition external folders', async () => {
    const c = path.join(tmp, 'Content')
    await touch(path.join(c, 'Rocks', 'a.uasset'))
    await touch(path.join(c, 'Maps', 'm.umap'))
    await touch(path.join(c, '__ExternalActors__', 'Maps', 'x.uasset'))
    await touch(path.join(c, '__ExternalObjects__', 'Maps', 'y.uasset'))
    await touch(path.join(c, 'Loose.uasset'))
    await touch(path.join(c, 'Level.umap'))
    await touch(path.join(c, 'readme.txt'))
    expect(await listTopLevelFolders(c)).toEqual(['Maps', 'Rocks'])
    expect(await listLoosePackages(c)).toEqual(['Level', 'Loose'])
  })

  it('returns empty lists for a missing directory', async () => {
    expect(await listTopLevelFolders(path.join(tmp, 'nope'))).toEqual([])
    expect(await listLoosePackages(path.join(tmp, 'nope'))).toEqual([])
  })
})

describe('listContentPlugins', () => {
  it('finds nested plugins that can contain content, ignoring others', async () => {
    const proj = path.join(tmp, 'Proj')
    await touch(
      path.join(proj, 'Plugins', 'Art', 'Art.uplugin'),
      JSON.stringify({ FileVersion: 3, CanContainContent: true })
    )
    await touch(
      path.join(proj, 'Plugins', 'Group', 'Env', 'Env.uplugin'),
      '\uFEFF' + JSON.stringify({ FileVersion: 3, CanContainContent: true })
    )
    await touch(
      path.join(proj, 'Plugins', 'CodeOnly', 'CodeOnly.uplugin'),
      JSON.stringify({ FileVersion: 3, Modules: [] })
    )
    await touch(path.join(proj, 'Plugins', 'Broken', 'Broken.uplugin'), '{not json')
    const r = await listContentPlugins(proj)
    expect(r).toEqual([
      { name: 'Art', dir: path.join(proj, 'Plugins', 'Art') },
      { name: 'Env', dir: path.join(proj, 'Plugins', 'Group', 'Env') }
    ])
  })

  it('returns [] when the project has no Plugins folder', async () => {
    expect(await listContentPlugins(path.join(tmp, 'Empty'))).toEqual([])
  })

  it('listProjectPluginNames returns every local plugin, content or not', async () => {
    const proj = path.join(tmp, 'Proj')
    await touch(path.join(proj, 'Plugins', 'Art', 'Art.uplugin'), '{"CanContainContent":true}')
    await touch(path.join(proj, 'Plugins', 'G', 'Code', 'Code.uplugin'), '{}')
    await touch(path.join(proj, 'Plugins', 'Bad', 'Bad.uplugin'), 'nope')
    expect(await listProjectPluginNames(proj)).toEqual(['Art', 'Bad', 'Code'])
  })
})

describe('buildDestination', () => {
  const plugins = [{ name: 'Art', dir: 'D:/P/Plugins/Art' }]

  it('maps every top folder under /Game/<subfolder>', () => {
    const r = buildDestination({
      destination: { mount: 'game', subfolder: 'ThirdParty/Env' },
      topFolders: ['Maps', 'Rocks'],
      looseAssets: ['Loose'],
      plugins
    })
    if (!r.ok) throw new Error(r.error)
    expect(r.plan.moves).toEqual([
      { from: '/Game/Maps', to: '/Game/ThirdParty/Env/Maps', kind: 'folder' },
      { from: '/Game/Rocks', to: '/Game/ThirdParty/Env/Rocks', kind: 'folder' },
      { from: '/Game/Loose', to: '/Game/ThirdParty/Env/Loose', kind: 'asset' }
    ])
    expect(r.plan.pluginName).toBeNull()
    expect(r.plan.destRoot).toBe('/Game/ThirdParty/Env')
    expect(r.plan.redirectorRoots).toEqual(['/Game'])
    expect(r.plan.copyOutRel).toEqual([
      'ThirdParty/Env',
      '__ExternalActors__/ThirdParty/Env',
      '__ExternalObjects__/ThirdParty/Env'
    ])
  })

  it('renames the single top folder in place under /Game', () => {
    const r = buildDestination({
      destination: { mount: 'game', rename: 'Stones' },
      topFolders: ['Rocks'],
      looseAssets: [],
      plugins
    })
    if (!r.ok) throw new Error(r.error)
    expect(r.plan.moves).toEqual([{ from: '/Game/Rocks', to: '/Game/Stones', kind: 'folder' }])
    expect(r.plan.copyOutRel[0]).toBe('Stones')
  })

  it('maps into a plugin mount, copying the whole plugin content when no subfolder', () => {
    const r = buildDestination({
      destination: { mount: { plugin: 'Art' }, rename: 'Stones' },
      topFolders: ['Rocks'],
      looseAssets: [],
      plugins
    })
    if (!r.ok) throw new Error(r.error)
    expect(r.plan.moves).toEqual([{ from: '/Game/Rocks', to: '/Art/Stones', kind: 'folder' }])
    expect(r.plan.pluginName).toBe('Art')
    expect(r.plan.destRoot).toBe('/Art')
    expect(r.plan.redirectorRoots).toEqual(['/Game', '/Art'])
    expect(r.plan.copyOutRel).toEqual([''])
  })

  it('rejects unknown plugins, bad names and unsupported renames', () => {
    const base = { topFolders: ['Rocks'], looseAssets: [] as string[], plugins }
    const cases = [
      { mount: { plugin: 'Nope' } },
      { mount: 'game', subfolder: '../x' },
      { mount: 'game', subfolder: 'A B' },
      { mount: 'game', rename: 'a.b' },
      { mount: 'game', rename: 'rocks' },
      { mount: 'game', subfolder: 'Rocks/Sub' }
    ] as const
    for (const destination of cases) {
      const r = buildDestination({ ...base, destination })
      expect(r.ok, JSON.stringify(destination)).toBe(false)
    }
  })

  it('refuses a rename with several top folders or loose assets', () => {
    expect(
      buildDestination({
        destination: { mount: 'game', subfolder: 'X', rename: 'Y' },
        topFolders: ['A', 'B'],
        looseAssets: [],
        plugins
      }).ok
    ).toBe(false)
    expect(
      buildDestination({
        destination: { mount: 'game', subfolder: 'X', rename: 'Y' },
        topFolders: ['A'],
        looseAssets: ['L'],
        plugins
      }).ok
    ).toBe(false)
  })

  it('refuses an empty pack and the default destination', () => {
    expect(
      buildDestination({
        destination: { mount: 'game', subfolder: 'X' },
        topFolders: [],
        looseAssets: [],
        plugins
      }).ok
    ).toBe(false)
    expect(
      buildDestination({
        destination: { mount: 'game' },
        topFolders: ['A'],
        looseAssets: [],
        plugins
      }).ok
    ).toBe(false)
  })
})

describe('renderUproject', () => {
  it('copies EngineAssociation, inherits non-local plugins and enables the scripting plugins', () => {
    const out = JSON.parse(
      renderUproject({
        targetUproject: {
          FileVersion: 3,
          EngineAssociation: '5.4',
          Modules: [{ Name: 'Game', Type: 'Runtime' }],
          Plugins: [
            { Name: 'Water', Enabled: true, MarketplaceURL: 'x' },
            { Name: 'MyLocal', Enabled: true },
            { Name: 'PythonScriptPlugin', Enabled: false },
            { Name: 'ModelingToolsEditorMode', Enabled: false }
          ]
        },
        localPluginNames: ['MyLocal'],
        stubPlugin: 'Art'
      })
    )
    expect(out).toEqual({
      FileVersion: 3,
      EngineAssociation: '5.4',
      Category: '',
      Description: 'ReHoarder relocation scratch project',
      Plugins: [
        { Name: 'Water', Enabled: true },
        { Name: 'ModelingToolsEditorMode', Enabled: false },
        { Name: 'PythonScriptPlugin', Enabled: true },
        { Name: 'EditorScriptingUtilities', Enabled: true },
        { Name: 'Art', Enabled: true }
      ]
    })
  })

  it('tolerates a descriptor without plugins or association', () => {
    const out = JSON.parse(
      renderUproject({ targetUproject: {}, localPluginNames: [], stubPlugin: null })
    )
    expect(out.EngineAssociation).toBe('')
    expect(out.Plugins.map((p: { Name: string }) => p.Name)).toEqual([
      'PythonScriptPlugin',
      'EditorScriptingUtilities'
    ])
  })
})

describe('renderUpluginStub', () => {
  it('declares a content-only plugin', () => {
    expect(JSON.parse(renderUpluginStub('Art'))).toEqual({
      FileVersion: 3,
      Version: 1,
      VersionName: '1.0',
      FriendlyName: 'Art',
      CanContainContent: true,
      EnabledByDefault: true,
      Modules: []
    })
  })
})

describe('renderRelocateScript', () => {
  const plan: RelocatePlan = {
    mount: 'game',
    pluginName: null,
    destRoot: '/Game/Third_Party',
    destRelDir: 'Third_Party',
    moves: [
      { from: '/Game/Rocks-01', to: '/Game/Third_Party/Rocks-01', kind: 'folder' },
      { from: '/Game/Loose', to: '/Game/Third_Party/Loose', kind: 'asset' }
    ],
    redirectorRoots: ['/Game'],
    copyOutRel: ['Third_Party']
  }

  it('embeds the plan as a single JSON string literal, never raw concatenation', () => {
    const resultPath = 'C:\\Users\\Me\\AppData\\Roaming\\ReHoarder\\relocate\\job "1"\\result.json'
    const script = renderRelocateScript(plan, resultPath)
    const m = script.match(/^PLAN = json\.loads\((".*")\)$/m)
    expect(m).not.toBeNull()
    // The literal is valid JSON (so also a valid Python string literal) and
    // decodes back to the plan plus the result path, backslashes and quotes intact.
    const decoded = JSON.parse(JSON.parse(m![1]))
    expect(decoded).toEqual({ ...plan, resultPath, consolidate: [] })
    // No path shows up anywhere outside that literal.
    expect(script.replace(m![0], '')).not.toContain('Rocks-01')
    expect(script.replace(m![0], '')).not.toContain('result.json')
  })

  it('uses the expected Unreal Python APIs and always writes the result', () => {
    const script = renderRelocateScript(plan, 'C:/r/result.json')
    for (const api of [
      'unreal.AssetRegistryHelpers.get_asset_registry()',
      'unreal.AssetRenameData(',
      '.rename_assets(',
      'unreal.ARFilter(',
      'unreal.AssetToolsHelpers.get_asset_tools().fixup_referencers(',
      'unreal.EditorLoadingAndSavingUtils.save_dirty_packages(True, True)',
      'finally:'
    ]) {
      expect(script, api).toContain(api)
    }
  })

  it('holds back the assets it is told to consolidate and reports a wholly refused batch', () => {
    const script = renderRelocateScript(plan, 'C:/r/result.json', {
      consolidate: ['BP_House', 'BP_DayNight']
    })
    const embedded = JSON.parse(JSON.parse(script.match(/^PLAN = json\.loads\((".*")\)$/m)![1]))
    expect(embedded.consolidate).toEqual(['BP_House', 'BP_DayNight'])
    expect(script).toContain('result["refusedBatch"] = True')
    expect(script).toContain('unreal.EditorAssetLibrary.consolidate_assets(')
  })

  it('judges the batch rename by where each asset landed, not by its coarse bool', () => {
    const script = renderRelocateScript(plan, 'C:/r/result.json')
    expect(script).toContain('unreal.EditorAssetLibrary.does_asset_exist(target_of(data))')
    expect(script).not.toContain('"AssetTools.rename_assets reported a failure"')
  })

  it('renames one primary asset per package, never a BlueprintGeneratedClass on its own', () => {
    const script = renderRelocateScript(plan, 'C:/r/result.json')
    expect(script).toContain('GeneratedClass')
    expect(script).not.toContain('rename_directory(')
  })

  it('recompiles moved Blueprints before saving (commandlets do not regenerate their classes)', () => {
    const script = renderRelocateScript(plan, 'C:/r/result.json')
    expect(script).toContain('unreal.BlueprintEditorLibrary.compile_blueprint(')
    expect(script.indexOf('compile_blueprints(registry)')).toBeLessThan(
      script.indexOf('save_dirty_packages(True, True)')
    )
  })
})

describe('listContentSubfolders', () => {
  it('lists existing folders as /-joined paths up to the depth limit, skipping engine-managed ones', async () => {
    const content = path.join(tmp, 'Content')
    await fsp.mkdir(path.join(content, 'ThirdParty', 'Env', 'Rocks', 'Deep'), { recursive: true })
    await fsp.mkdir(path.join(content, 'Maps'), { recursive: true })
    await fsp.mkdir(path.join(content, '__ExternalActors__', 'Maps'), { recursive: true })
    await fsp.mkdir(path.join(content, 'Collections'), { recursive: true })
    await fsp.mkdir(path.join(content, 'Has Space'), { recursive: true })
    await touch(path.join(content, 'Maps', 'Main.umap'))
    expect(await listContentSubfolders(content, 3)).toEqual([
      'Maps',
      'ThirdParty',
      'ThirdParty/Env',
      'ThirdParty/Env/Rocks'
    ])
  })

  it('returns an empty list when the content folder does not exist', async () => {
    expect(await listContentSubfolders(path.join(tmp, 'Missing'), 3)).toEqual([])
  })
})

describe('findScriptModules', () => {
  it('collects /Script/<Module> imports from package files only', async () => {
    const pkg = Buffer.concat([
      Buffer.from([0xc1, 0x83, 0x2a, 0x9e, 0, 0]),
      Buffer.from('\u0000/Script/ChaosVehicles\u0000/Script/Engine\u0000/Script/ChaosVehicles\u0000', 'latin1')
    ])
    await touch(path.join(tmp, 'Pack', 'Blueprints', 'BP_Truck.uasset'), pkg as unknown as string)
    await touch(path.join(tmp, 'Pack', 'Maps', 'M.umap'), '/Script/Niagara')
    await touch(path.join(tmp, 'Pack', 'readme.txt'), '/Script/NotAPackage')
    expect(await findScriptModules(tmp)).toEqual(['ChaosVehicles', 'Engine', 'Niagara'])
  })
})

describe('findPluginsForModules', () => {
  it('maps module names to the engine plugins that declare them', async () => {
    const engineRoot = path.join(tmp, 'UE_5.7')
    const plugins = path.join(engineRoot, 'Engine', 'Plugins')
    await touch(
      path.join(plugins, 'Experimental', 'ChaosVehiclesPlugin', 'ChaosVehiclesPlugin.uplugin'),
      JSON.stringify({ Modules: [{ Name: 'ChaosVehicles' }, { Name: 'ChaosVehiclesEditor' }] })
    )
    await touch(
      path.join(plugins, 'FX', 'Niagara', 'Niagara.uplugin'),
      JSON.stringify({ Modules: [{ Name: 'Niagara' }] })
    )
    await touch(path.join(plugins, 'Broken', 'Broken.uplugin'), '{ not json')
    expect(
      await findPluginsForModules(engineRoot, ['ChaosVehicles', 'ChaosVehiclesEditor', 'Engine'])
    ).toEqual(['ChaosVehiclesPlugin'])
  })
})

describe('renderUproject extra plugins', () => {
  it('enables plugins the pack needs, overriding a disabled inherited entry', () => {
    const out = JSON.parse(
      renderUproject({
        targetUproject: {
          EngineAssociation: '5.7',
          Plugins: [{ Name: 'ChaosVehiclesPlugin', Enabled: false }]
        },
        localPluginNames: [],
        stubPlugin: null,
        extraPlugins: ['ChaosVehiclesPlugin', 'Niagara']
      })
    ) as { Plugins: Array<{ Name: string; Enabled: boolean }> }
    const byName = new Map(out.Plugins.map((p) => [p.Name, p.Enabled]))
    expect(byName.get('ChaosVehiclesPlugin')).toBe(true)
    expect(byName.get('Niagara')).toBe(true)
    expect(out.Plugins.filter((p) => p.Name === 'ChaosVehiclesPlugin')).toHaveLength(1)
  })
})
