import { promises as fsp } from 'node:fs'
import * as path from 'node:path'
import {
  validateSegment,
  validateSegmentPath,
  validateDestination,
  isDefaultDestination,
  mountRoot,
  type AddToProjectDestination,
  type DestinationMount
} from '../shared/relocate-destination'

export {
  validateSegment,
  validateSegmentPath,
  validateDestination,
  isDefaultDestination,
  type AddToProjectDestination,
  type DestinationMount
}

/**
 * Pure planning helpers for "Add to project" relocation (see
 * `projects-relocate.ts` for the orchestration). Everything here is either a
 * read-only fs listing or a string renderer, so it can be unit tested without
 * Unreal.
 */

/** World Partition side folders. They follow their maps when a map is moved, so they are never moved on their own. */
const EXTERNAL_FOLDERS = ['__ExternalActors__', '__ExternalObjects__']

const PACKAGE_EXTS = ['.uasset', '.umap']

export interface ContentPlugin {
  /** Plugin name = `.uplugin` basename = its mount point (`/<name>/`). */
  name: string
  /** Absolute directory holding the `.uplugin`. */
  dir: string
}

export interface RelocateMove {
  /** Unreal package path, e.g. `/Game/Rocks`. */
  from: string
  to: string
  kind: 'folder' | 'asset'
}

export interface RelocatePlan {
  mount: DestinationMount
  /** Plugin name when mounting into a plugin, `null` for `/Game`. */
  pluginName: string | null
  /** Unreal path everything lands under, e.g. `/Game/ThirdParty` or `/Art`. */
  destRoot: string
  /** `destRoot` relative to the mount's `Content/` dir, `/`-separated; `''` = the whole mount. */
  destRelDir: string
  moves: RelocateMove[]
  /** Package paths searched (recursively) for left-over ObjectRedirectors. */
  redirectorRoots: string[]
  /**
   * Directories (relative to the mount's `Content/`, `/`-separated) copied
   * back into the real project after the editor step. `''` = the whole mount
   * content dir.
   */
  copyOutRel: string[]
}

export async function listTopLevelFolders(contentDir: string): Promise<string[]> {
  let entries
  try {
    entries = await fsp.readdir(contentDir, { withFileTypes: true })
  } catch {
    return []
  }
  return entries
    .filter((e) => e.isDirectory() && !EXTERNAL_FOLDERS.includes(e.name))
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b))
}

/** Package names (no extension) of `.uasset` / `.umap` files sitting directly in `Content/`. */
export async function listLoosePackages(contentDir: string): Promise<string[]> {
  let entries
  try {
    entries = await fsp.readdir(contentDir, { withFileTypes: true })
  } catch {
    return []
  }
  return entries
    .filter((e) => e.isFile() && PACKAGE_EXTS.includes(path.extname(e.name).toLowerCase()))
    .map((e) => path.basename(e.name, path.extname(e.name)))
    .sort((a, b) => a.localeCompare(b))
}

interface ScannedPlugin extends ContentPlugin {
  canContainContent: boolean
}

/**
 * Every `.uplugin` under `<projectDir>/Plugins/**`. Like Unreal, we stop
 * descending once a folder holds a `.uplugin` (plugins don't nest). A
 * malformed descriptor still yields the plugin, flagged as content-less.
 */
async function scanProjectPlugins(projectDir: string): Promise<ScannedPlugin[]> {
  const out: ScannedPlugin[] = []
  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > 6) return
    let entries
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    const descriptor = entries.find(
      (e) => e.isFile() && e.name.toLowerCase().endsWith('.uplugin')
    )
    if (descriptor) {
      let canContainContent = false
      try {
        const raw = (await fsp.readFile(path.join(dir, descriptor.name), 'utf-8')).replace(
          /^\uFEFF/,
          ''
        )
        canContainContent =
          (JSON.parse(raw) as { CanContainContent?: unknown }).CanContainContent === true
      } catch {
        // Unreadable or malformed descriptor: never offered as a destination.
      }
      out.push({
        name: path.basename(descriptor.name, path.extname(descriptor.name)),
        dir,
        canContainContent
      })
      return
    }
    for (const e of entries) {
      if (e.isDirectory()) await walk(path.join(dir, e.name), depth + 1)
    }
  }
  await walk(path.join(projectDir, 'Plugins'), 0)
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

/** Project plugins whose descriptor sets `"CanContainContent": true`. */
export async function listContentPlugins(projectDir: string): Promise<ContentPlugin[]> {
  return (await scanProjectPlugins(projectDir))
    .filter((p) => p.canContainContent)
    .map(({ name, dir }) => ({ name, dir }))
}

/** Folders Unreal manages itself: never offered as a destination. */
const MANAGED_CONTENT_FOLDERS = new Set(['collections', 'developers'])

/**
 * Existing folders under a mount's content directory, as `/`-joined paths
 * relative to it, sorted, down to `maxDepth` levels. Feeds the Subfolder
 * suggestions in the Add to project dialog, so only names the destination
 * validator accepts are returned (engine-managed and `__External*__` folders
 * are left out).
 */
export async function listContentSubfolders(contentDir: string, maxDepth: number): Promise<string[]> {
  const out: string[] = []
  const walk = async (dir: string, rel: string, depth: number): Promise<void> => {
    if (depth > maxDepth) return
    let entries: import('node:fs').Dirent[]
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue
      if (e.name.startsWith('__')) continue
      if (depth === 1 && MANAGED_CONTENT_FOLDERS.has(e.name.toLowerCase())) continue
      if (validateSegment(e.name) !== null) continue
      const childRel = rel ? `${rel}/${e.name}` : e.name
      out.push(childRel)
      await walk(path.join(dir, e.name), childRel, depth + 1)
    }
  }
  await walk(contentDir, '', 1)
  return out.sort((a, b) => a.localeCompare(b))
}

/** Names of every plugin living inside the project folder (content or code). */
export async function listProjectPluginNames(projectDir: string): Promise<string[]> {
  return (await scanProjectPlugins(projectDir)).map((p) => p.name)
}

export type BuildDestinationResult = { ok: true; plan: RelocatePlan } | { ok: false; error: string }

export function buildDestination(input: {
  destination: AddToProjectDestination
  topFolders: string[]
  looseAssets: string[]
  plugins: ContentPlugin[]
}): BuildDestinationResult {
  const { destination, topFolders, looseAssets, plugins } = input
  const subfolder = (destination.subfolder ?? '').trim()
  const rename = (destination.rename ?? '').trim()

  if (topFolders.length === 0 && looseAssets.length === 0) {
    return { ok: false, error: "The pack's Content/ folder is empty" }
  }
  if (isDefaultDestination(destination, topFolders)) {
    return { ok: false, error: 'Default destination: nothing to relocate' }
  }

  let pluginName: string | null = null
  if (destination.mount !== 'game') {
    const wanted = destination.mount.plugin
    const plugin = plugins.find((p) => p.name === wanted)
    if (!plugin) {
      return {
        ok: false,
        error: `Plugin "${wanted}" was not found in the project or cannot contain content`
      }
    }
    pluginName = plugin.name
  }

  const invalid = validateDestination(destination, topFolders, looseAssets)
  if (invalid) return { ok: false, error: invalid }

  const root = mountRoot(destination.mount)
  const destRelDir =
    destination.mount === 'game' && subfolder === '' ? rename : subfolder
  const destRoot = destRelDir === '' ? root : `${root}/${destRelDir}`
  const base = subfolder === '' ? root : `${root}/${subfolder}`

  const moves: RelocateMove[] = [
    ...topFolders.map<RelocateMove>((t) => ({
      from: `/Game/${t}`,
      to: `${base}/${rename !== '' ? rename : t}`,
      kind: 'folder'
    })),
    ...looseAssets.map<RelocateMove>((a) => ({
      from: `/Game/${a}`,
      to: `${base}/${a}`,
      kind: 'asset'
    }))
  ]

  return {
    ok: true,
    plan: {
      mount: destination.mount,
      pluginName,
      destRoot,
      destRelDir,
      moves,
      redirectorRoots: pluginName ? ['/Game', `/${pluginName}`] : ['/Game'],
      copyOutRel:
        destRelDir === '' ? [''] : [destRelDir, ...EXTERNAL_FOLDERS.map((f) => `${f}/${destRelDir}`)]
    }
  }
}

/** Absolute `Content/` dir backing a mount: `<project>/Content` or `<plugin dir>/Content`. */
export function mountContentDir(
  mount: DestinationMount,
  projectDir: string,
  pluginDir: string | null
): string {
  if (mount === 'game') return path.join(projectDir, 'Content')
  if (!pluginDir) throw new Error(`No directory for plugin ${mount.plugin}`)
  return path.join(pluginDir, 'Content')
}

const REQUIRED_PLUGINS = ['PythonScriptPlugin', 'EditorScriptingUtilities']

/**
 * `Scratch.uproject`. Inherits the target's `EngineAssociation` and its
 * plugin toggles (so assets whose classes live in engine or marketplace
 * plugins still load), except plugins that only exist inside the target
 * project folder: those are not present in the scratch project and would stop
 * the editor from starting. `Modules` are never copied (no source code here).
 */
/** Bytes read from the start of each package: the name table (with its `/Script/...` imports) lives in the header. */
const PACKAGE_HEADER_BYTES = 4 * 1024 * 1024
const SCRIPT_IMPORT_RE = /\/Script\/([A-Za-z0-9_]+)/g

/**
 * Native modules the pack's packages import (`/Script/<Module>` entries in
 * their name tables), sorted. Used to enable the engine plugins those modules
 * live in, otherwise the scratch editor can't load e.g. Chaos Vehicles
 * Blueprints and `rename_directory` refuses the whole folder.
 */
export async function findScriptModules(contentDir: string): Promise<string[]> {
  const found = new Set<string>()
  const walk = async (dir: string): Promise<void> => {
    let entries: import('node:fs').Dirent[]
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const abs = path.join(dir, e.name)
      if (e.isDirectory()) {
        await walk(abs)
        continue
      }
      const ext = path.extname(e.name).toLowerCase()
      if (ext !== '.uasset' && ext !== '.umap') continue
      let text: string
      try {
        const handle = await fsp.open(abs, 'r')
        try {
          const buf = Buffer.alloc(PACKAGE_HEADER_BYTES)
          const { bytesRead } = await handle.read(buf, 0, buf.length, 0)
          text = buf.subarray(0, bytesRead).toString('latin1')
        } finally {
          await handle.close()
        }
      } catch {
        continue
      }
      for (const m of text.matchAll(SCRIPT_IMPORT_RE)) found.add(m[1])
    }
  }
  await walk(contentDir)
  return [...found].sort()
}

/**
 * Engine plugins (under `<engineRoot>/Engine/Plugins`, Marketplace included)
 * that declare any of `modules`. Modules owned by the engine core simply
 * don't match. Unreadable descriptors are skipped.
 */
export async function findPluginsForModules(
  engineRoot: string,
  modules: string[]
): Promise<string[]> {
  const wanted = new Set(modules.map((m) => m.toLowerCase()))
  const plugins = new Set<string>()
  if (wanted.size === 0) return []
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > 6) return
    let entries: import('node:fs').Dirent[]
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    const descriptor = entries.find((e) => e.isFile() && e.name.toLowerCase().endsWith('.uplugin'))
    if (descriptor) {
      try {
        const raw = JSON.parse(await fsp.readFile(path.join(dir, descriptor.name), 'utf-8')) as {
          Modules?: Array<{ Name?: unknown }>
        }
        const declares = (raw.Modules ?? []).some(
          (m) => typeof m?.Name === 'string' && wanted.has(m.Name.toLowerCase())
        )
        if (declares) plugins.add(path.basename(descriptor.name, path.extname(descriptor.name)))
      } catch {
        // malformed descriptor: ignore
      }
      return
    }
    for (const e of entries) {
      if (e.isDirectory()) await walk(path.join(dir, e.name), depth + 1)
    }
  }
  await walk(path.join(engineRoot, 'Engine', 'Plugins'), 0)
  return [...plugins].sort()
}

export function renderUproject(opts: {
  targetUproject: unknown
  localPluginNames: string[]
  stubPlugin: string | null
  /** Engine plugins the pack needs; always enabled, even if the target disables them. */
  extraPlugins?: string[]
}): string {
  const t = (opts.targetUproject ?? {}) as {
    EngineAssociation?: unknown
    Plugins?: unknown
  }
  const local = new Set(opts.localPluginNames.map((n) => n.toLowerCase()))
  const extra = (opts.extraPlugins ?? []).filter(
    (n) =>
      !REQUIRED_PLUGINS.some((r) => r.toLowerCase() === n.toLowerCase()) &&
      n.toLowerCase() !== (opts.stubPlugin ?? '').toLowerCase()
  )
  const forced = new Set(
    [...REQUIRED_PLUGINS, ...extra, ...(opts.stubPlugin ? [opts.stubPlugin] : [])].map((n) =>
      n.toLowerCase()
    )
  )
  const inherited: Array<{ Name: string; Enabled: boolean }> = []
  if (Array.isArray(t.Plugins)) {
    for (const p of t.Plugins as Array<{ Name?: unknown; Enabled?: unknown }>) {
      if (!p || typeof p.Name !== 'string') continue
      const key = p.Name.toLowerCase()
      if (local.has(key) || forced.has(key)) continue
      inherited.push({ Name: p.Name, Enabled: p.Enabled === true })
    }
  }
  const descriptor = {
    FileVersion: 3,
    EngineAssociation: typeof t.EngineAssociation === 'string' ? t.EngineAssociation : '',
    Category: '',
    Description: 'ReHoarder relocation scratch project',
    Plugins: [
      ...inherited,
      ...REQUIRED_PLUGINS.map((Name) => ({ Name, Enabled: true })),
      ...extra.map((Name) => ({ Name, Enabled: true })),
      ...(opts.stubPlugin ? [{ Name: opts.stubPlugin, Enabled: true }] : [])
    ]
  }
  return JSON.stringify(descriptor, null, '\t') + '\n'
}

/** Content-only plugin descriptor so `/<name>/` gets mounted in the scratch project. */
export function renderUpluginStub(name: string): string {
  return (
    JSON.stringify(
      {
        FileVersion: 3,
        Version: 1,
        VersionName: '1.0',
        FriendlyName: name,
        CanContainContent: true,
        EnabledByDefault: true,
        Modules: []
      },
      null,
      '\t'
    ) + '\n'
  )
}

/**
 * Python run by `UnrealEditor-Cmd.exe -run=pythonscript`. The plan and the
 * result path are embedded once, as a JSON document inside a JSON string
 * literal: a JSON string is also a valid Python 3 string literal (same `\"`,
 * `\\`, `\n`, `\uXXXX` escapes), so no user-controlled text is ever spliced
 * into Python code.
 */
export function renderRelocateScript(
  plan: RelocatePlan,
  resultPath: string,
  opts: {
    /** Asset names to move by duplicate + consolidate instead of the batch rename. */
    consolidate?: string[]
    /** Split a refused batch in halves to isolate the refused assets. */
    bisect?: boolean
  } = {}
): string {
  const literal = JSON.stringify(
    JSON.stringify({
      ...plan,
      resultPath,
      consolidate: opts.consolidate ?? [],
      ...(opts.bisect ? { bisect: true } : {})
    })
  )
  return `# Generated by ReHoarder: relocates an asset pack inside a throwaway scratch project.
import json
import traceback

import unreal

PLAN = json.loads(${literal})
RESULT_PATH = PLAN["resultPath"]

result = {"ok": False, "moved": 0, "redirectorsLeft": 0, "redirectors": [], "errors": []}


def log(msg):
    unreal.log("[ReHoarder] " + msg)


def class_name_of(asset_data):
    # UE 5.1+ exposes asset_class_path (a TopLevelAssetPath); 5.0 only has
    # the (later deprecated) asset_class name.
    try:
        return str(asset_data.asset_class_path.asset_name)
    except Exception:
        return str(asset_data.asset_class)


def find_redirectors(registry):
    found = []
    for root in PLAN["redirectorRoots"]:
        # Not filtering by class inside the ARFilter on purpose: 5.0 takes
        # class_names while 5.1+ deprecates it for class_paths. Checking the
        # class of each result works the same on every 5.x version.
        ar_filter = unreal.ARFilter(package_paths=[root], recursive_paths=True)
        for asset_data in registry.get_assets(ar_filter):
            if class_name_of(asset_data) == "ObjectRedirector":
                found.append(asset_data)
    return found


def primary_asset_of(registry, package_name):
    # Packages saved by older engines can list their BlueprintGeneratedClass
    # as a separate asset. Renaming that object on its own moves the class
    # into a package of its own and leaves the Blueprint unsavable, so each
    # package is renamed once, through its non-class asset.
    candidates = registry.get_assets_by_package_name(package_name)
    for asset_data in candidates:
        if not class_name_of(asset_data).endswith("GeneratedClass"):
            return asset_data
    return None


def rename_data_for(asset_data, new_package_path, new_name):
    asset = asset_data.get_asset()
    if asset is None:
        result["errors"].append("Could not load " + str(asset_data.package_name))
        return None
    return unreal.AssetRenameData(asset, new_package_path, new_name)


def collect_folder_renames(registry, src_root, dst_root):
    ar_filter = unreal.ARFilter(package_paths=[src_root], recursive_paths=True)
    seen = set()
    out = []
    for asset_data in registry.get_assets(ar_filter):
        package_name = str(asset_data.package_name)
        if package_name in seen:
            continue
        seen.add(package_name)
        primary = primary_asset_of(registry, package_name)
        if primary is None or class_name_of(primary) == "ObjectRedirector":
            continue
        package_path = str(primary.package_path)
        new_path = dst_root + package_path[len(src_root):]
        data = rename_data_for(primary, new_path, str(primary.asset_name))
        if data is not None:
            out.append(data)
    return out


def collect_asset_rename(registry, src_object_path, dst_object_path):
    src_package = src_object_path.split(".")[0]
    primary = primary_asset_of(registry, src_package)
    if primary is None:
        result["errors"].append("Could not find " + src_object_path)
        return []
    dst_package = dst_object_path.split(".")[0]
    new_path, _, new_name = dst_package.rpartition("/")
    data = rename_data_for(primary, new_path, new_name)
    return [] if data is None else [data]


def compile_blueprints(registry):
    # A commandlet rename leaves each Blueprint's generated class under its
    # old name, and saving then fails with "Illegal reference to private
    # object". The editor recompiles on rename; here we do it by hand.
    if not hasattr(unreal, "BlueprintEditorLibrary"):
        log("BlueprintEditorLibrary unavailable, Blueprints not recompiled")
        return
    ar_filter = unreal.ARFilter(package_paths=[PLAN["destRoot"]], recursive_paths=True)
    for asset_data in registry.get_assets(ar_filter):
        name = class_name_of(asset_data)
        if not name.endswith("Blueprint") or name.endswith("GeneratedBlueprint"):
            continue
        blueprint = asset_data.get_asset()
        if blueprint is None:
            continue
        try:
            unreal.BlueprintEditorLibrary.compile_blueprint(blueprint)
        except Exception as exc:
            log("compile failed for " + str(asset_data.package_name) + ": " + str(exc))


def main():
    registry = unreal.AssetRegistryHelpers.get_asset_registry()
    # Commandlets don't wait for the initial asset scan: force a synchronous
    # one so the EditorAssetLibrary calls below can see the pack.
    registry.search_all_assets(True)

    renames = []
    for move in PLAN["moves"]:
        log("moving " + move["from"] + " to " + move["to"])
        if move["kind"] == "folder":
            renames.extend(collect_folder_renames(registry, move["from"], move["to"]))
        else:
            renames.extend(collect_asset_rename(registry, move["from"], move["to"]))
    if result["errors"]:
        return
    if not renames:
        result["errors"].append("Nothing to move: the pack's packages were not found")
        return
    # One batch, like a Content Browser drag and drop: every package moves
    # together and references between them are rewritten in a single pass.
    asset_tools = unreal.AssetToolsHelpers.get_asset_tools()

    def target_of(data):
        return str(data.get_editor_property("new_package_path")) + "/" + str(
            data.get_editor_property("new_name")
        )

    def moved(data):
        return unreal.EditorAssetLibrary.does_asset_exist(target_of(data))

    # The rename manager is all-or-nothing: one asset it refuses (typically an
    # OK/Cancel "a native CDO references this" prompt, which unattended mode
    # answers Cancel) aborts the whole batch without touching anything. Split
    # a refused batch in halves until the refused assets are isolated, so all
    # the others still move in batches that rewrite references among them.
    def rename_batch(batch):
        if not batch:
            return []
        asset_tools.rename_assets(batch)
        left = [d for d in batch if not moved(d)]
        if len(left) < len(batch):
            # Save what moved before the next batch: the rename manager only
            # rewrites referencers it can "check out", and a package that
            # exists only in memory at its new path fails that check, which
            # would leave its references pointing at the old path.
            unreal.EditorLoadingAndSavingUtils.save_dirty_packages(True, True)
        if not left:
            return []
        if len(left) < len(batch):
            return rename_batch(left)
        if len(batch) == 1:
            return batch
        half = len(batch) // 2
        return rename_batch(batch[:half]) + rename_batch(batch[half:])

    # Assets ReHoarder already knows the rename manager refuses (it read their
    # names off the prompt in a previous run) stay out of the batch, so the
    # batch moves everything else in one go with every reference rewritten.
    held_names = set(PLAN.get("consolidate", []))
    held = [d for d in renames if str(d.get_editor_property("new_name")) in held_names]
    batch = [d for d in renames if str(d.get_editor_property("new_name")) not in held_names]
    asset_tools.rename_assets(batch)
    if batch and not any(moved(d) for d in batch):
        if not held_names and not PLAN.get("bisect"):
            # Nothing moved, nothing changed: report it so ReHoarder can rerun
            # with the refused assets held back instead of splitting the batch.
            result["refusedBatch"] = True
            result["errors"].append("The rename was refused for the whole batch")
            return
    else:
        unreal.EditorLoadingAndSavingUtils.save_dirty_packages(True, True)
    refused = held + rename_batch([d for d in batch if not moved(d)])
    for data in refused:
        source = data.get_editor_property("asset").get_path_name().split(".")[0]
        # Duplicate to the destination and consolidate the original into the
        # copy (the Content Browser's "Replace References"): every referencer
        # is retargeted and the original deleted, with no rename prompt.
        log("rename refused, consolidating instead: " + source + " -> " + target_of(data))
        copy = unreal.EditorAssetLibrary.duplicate_asset(source, target_of(data))
        original = unreal.EditorAssetLibrary.load_asset(source)
        if copy is None or original is None or not unreal.EditorAssetLibrary.consolidate_assets(copy, [original]):
            log("consolidation failed: " + source)
    renamed_ok = not refused
    missing = [target_of(d) for d in renames if not moved(d)]
    if missing:
        result["errors"].append(
            str(len(missing)) + " of " + str(len(renames)) + " asset(s) did not move, e.g. "
            + ", ".join(missing[:10])
        )
        return
    if not renamed_ok:
        log("rename_assets reported a failure but every asset reached its destination")

    redirectors = find_redirectors(registry)
    if redirectors:
        log("fixing up " + str(len(redirectors)) + " redirector(s)")
        loaded = [r for r in (a.get_asset() for a in redirectors) if r is not None]
        tools = unreal.AssetToolsHelpers.get_asset_tools()
        if loaded and hasattr(tools, "fixup_referencers"):
            # Default fixup mode deletes the redirectors it could fix.
            unreal.AssetToolsHelpers.get_asset_tools().fixup_referencers(loaded)
        elif loaded:
            # Not exposed to Python on older engines (5.5): the redirectors are
            # kept and reported, and "Cleanup redirectors" finishes the job.
            log("fixup_referencers unavailable on this engine, redirectors kept")

    # Redirectors still left are NOT deleted: force deleting them would null
    # the references pointing at them. ReHoarder copies them into the project
    # instead, so references keep resolving until "Cleanup redirectors" runs.
    left = find_redirectors(registry)
    result["redirectorsLeft"] = len(left)
    result["redirectors"] = [str(a.package_name) for a in left]

    compile_blueprints(registry)

    if not unreal.EditorLoadingAndSavingUtils.save_dirty_packages(True, True):
        result["errors"].append("save_dirty_packages reported a failure")
    if unreal.EditorAssetLibrary.does_directory_exist(PLAN["destRoot"]):
        unreal.EditorAssetLibrary.save_directory(PLAN["destRoot"], True, True)
        result["moved"] = len(
            unreal.EditorAssetLibrary.list_assets(PLAN["destRoot"], True, False)
        )
    if result["moved"] == 0:
        result["errors"].append("No assets found under " + PLAN["destRoot"] + " after the move")
    result["ok"] = len(result["errors"]) == 0


try:
    main()
except Exception:
    result["ok"] = False
    result["errors"].append(traceback.format_exc())
finally:
    with open(RESULT_PATH, "w", encoding="utf-8") as result_file:
        json.dump(result, result_file)
    log("result written to " + RESULT_PATH)
`
}
