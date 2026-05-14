import { promises as fsp } from 'node:fs'
import * as path from 'node:path'

export interface ProjectInfo {
  /** Friendly name — the `.uproject` filename without the extension. */
  name: string
  /** Absolute path to the `.uproject` file. */
  uprojectPath: string
  /** Absolute path to the project folder (parent of the `.uproject`). */
  projectDir: string
  /** The configured base path (entry of `settings.projectPaths`) this project was discovered under. */
  rootPath: string
  /** Value of `EngineAssociation` from the descriptor (`5.4`, `4.27`, a GUID for source builds, or `''`). */
  engineAssociation: string
  description: string
  category: string
  /** `true` when the descriptor declares at least one C++ module — i.e. a code project. */
  hasCode: boolean
  /** Last-modified time of the `.uproject` file in ms (proxy for "last opened/edited"). */
  lastModified: number
  /** When the project was created with ReHoarder, the asset source it derived from (`'fab'` / `'vault'`). */
  rehoarderSource: string | null
  /** When the project was created with ReHoarder, the asset sourceId it derived from. */
  rehoarderSourceId: string | null
  /** Resolved by the IPC layer via `assetsRepo.image_url`. `null` when there's no `.rehoarder.json` or no matching asset row. */
  imageUrl: string | null
}

interface UProjectDescriptor {
  EngineAssociation?: string
  Description?: string
  Category?: string
  Modules?: Array<{ Name?: string; Type?: string }>
}

/** Max directory depth from each configured base path. 8 covers archival layouts like
 *  `<base>/Templates/MyClient/Year/<project>` without blowing up on accidental
 *  configuration of a filesystem root. */
const MAX_DEPTH = 8

/** Skip these names whenever we see them — both to dodge huge irrelevant trees and to
 *  avoid scanning the insides of an engine install if someone configures `C:\Program Files\Epic Games`
 *  as a project root by mistake. */
const SKIP_DIR_NAMES = new Set<string>([
  'node_modules',
  '.git',
  '.svn',
  '.hg',
  '.idea',
  '.vs',
  '.vscode',
  'Engine',
  'FeaturePacks'
])

/**
 * Recursively scan each `baseDir` for Unreal projects. As soon as a directory contains
 * a `*.uproject` it is treated as a project and we **do not descend further** — this
 * keeps us out of `Saved/`, `Intermediate/`, `Plugins/Marketplace/...`, etc., while still
 * finding projects nested under arbitrary archive layouts (e.g. `O:\UnrealArchive\Templates\Foo\Foo.uproject`).
 */
export async function scanProjects(baseDirs: string[]): Promise<ProjectInfo[]> {
  const results: ProjectInfo[] = []
  const seenPaths = new Set<string>()

  for (const baseDir of baseDirs) {
    await walk(baseDir, baseDir, 0, results, seenPaths)
  }

  results.sort((a, b) => b.lastModified - a.lastModified)
  return results
}

async function walk(
  dir: string,
  rootPath: string,
  depth: number,
  results: ProjectInfo[],
  seenPaths: Set<string>
): Promise<void> {
  let entries: Array<{ name: string; isDirectory: boolean }>
  try {
    const raw = await fsp.readdir(dir, { withFileTypes: true })
    entries = raw.map((e) => ({ name: e.name, isDirectory: e.isDirectory() }))
  } catch {
    return
  }

  // First pass: if this dir IS a project, record it and stop — don't descend into
  // engine subtrees of a project (Saved/, Intermediate/, Plugins/, Content/, ...).
  for (const e of entries) {
    if (!e.isDirectory && e.name.toLowerCase().endsWith('.uproject')) {
      const uproject = path.join(dir, e.name)
      if (seenPaths.has(uproject)) return
      const info = await readProjectInfo(uproject, dir, rootPath)
      if (info) {
        results.push(info)
        seenPaths.add(uproject)
      }
      return
    }
  }

  if (depth >= MAX_DEPTH) return

  // Second pass: recurse into child directories.
  for (const e of entries) {
    if (!e.isDirectory) continue
    if (e.name.startsWith('.')) continue
    if (SKIP_DIR_NAMES.has(e.name)) continue
    await walk(path.join(dir, e.name), rootPath, depth + 1, results, seenPaths)
  }
}

async function readProjectInfo(
  uprojectPath: string,
  projectDir: string,
  rootPath: string
): Promise<ProjectInfo | null> {
  let raw: string
  let stat
  try {
    raw = await fsp.readFile(uprojectPath, 'utf-8')
    stat = await fsp.stat(uprojectPath)
  } catch {
    return null
  }
  let d: UProjectDescriptor = {}
  try {
    d = JSON.parse(raw) as UProjectDescriptor
  } catch {
    // tolerate malformed descriptors — we still report the project, just with empty fields
  }
  const base = path.basename(uprojectPath)
  const nameNoExt = base.replace(/\.uproject$/i, '')
  const hasCode = Array.isArray(d.Modules) && d.Modules.length > 0
  const marker = await readRehoarderMarker(projectDir)
  const autoScreenshot = await findProjectAutoScreenshot(projectDir)
  return {
    name: nameNoExt,
    uprojectPath,
    projectDir,
    rootPath,
    engineAssociation: d.EngineAssociation ?? '',
    description: d.Description ?? '',
    category: d.Category ?? '',
    hasCode,
    lastModified: stat.mtimeMs,
    rehoarderSource: marker?.source ?? null,
    rehoarderSourceId: marker?.sourceId ?? null,
    // Start with the local Unreal auto-screenshot when present (this is what
    // AMS shows). The IPC layer may later replace it with the Fab thumbnail
    // when a `.rehoarder.json` marker links the project to its source asset.
    imageUrl: autoScreenshot
  }
}

/**
 * Look for an Unreal-generated thumbnail inside the project's `Saved/` tree.
 * UE writes `Saved/AutoScreenshot.png` on certain editor operations; some
 * versions place it under `Saved/Thumbnails/` instead. Returns a `rh-file://`
 * URL the renderer can drop straight into an `<img>` tag, or `null` if no
 * candidate file is found.
 */
async function findProjectAutoScreenshot(projectDir: string): Promise<string | null> {
  const candidates = [
    path.join(projectDir, 'Saved', 'AutoScreenshot.png'),
    path.join(projectDir, 'Saved', 'Thumbnails', 'AutoScreenshot.png')
  ]
  for (const candidate of candidates) {
    try {
      await fsp.access(candidate)
      return toRhFileUrl(candidate)
    } catch {
      // not present
    }
  }
  return null
}

/**
 * Convert an absolute filesystem path into a `rh-file://` URL the renderer
 * can drop into an `<img>` tag.
 *
 * The scheme is registered as `standard`, so Chromium's WHATWG URL parser
 * treats `rh-file://<authority>/<path>` like an http URL — the segment
 * between `//` and the next `/` is the host. If we put the drive letter
 * there (`rh-file:///O:/path`), Chromium parses host=`O`, lowercases it to
 * `o`, and strips the drive from the path. We dodge that entirely by using
 * a fixed host (`local`) so the drive letter always lives in the pathname,
 * where `:` is just a literal character.
 */
export function toRhFileUrl(absolutePath: string): string {
  const urlPath = absolutePath.replace(/\\/g, '/')
  const withLeadingSlash = urlPath.startsWith('/') ? urlPath : '/' + urlPath
  return 'rh-file://local' + encodeURI(withLeadingSlash)
}

/**
 * Read the `.rehoarder.json` marker we stamp next to a `.uproject` when the
 * project is created via the Create-project flow. The marker traces the
 * project back to its source asset so the Projects tab can fetch the same
 * thumbnail / metadata we already show on the Assets tab. Missing or malformed
 * marker → `null` (the project just won't have a thumbnail).
 */
async function readRehoarderMarker(
  projectDir: string
): Promise<{ source: string; sourceId: string } | null> {
  const markerPath = path.join(projectDir, '.rehoarder.json')
  let raw: string
  try {
    raw = await fsp.readFile(markerPath, 'utf-8')
  } catch {
    return null
  }
  try {
    const j = JSON.parse(raw) as { source?: unknown; sourceId?: unknown }
    if (typeof j.source !== 'string' || typeof j.sourceId !== 'string') return null
    return { source: j.source, sourceId: j.sourceId }
  } catch {
    return null
  }
}
