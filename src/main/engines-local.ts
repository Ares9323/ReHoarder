import { promises as fsp } from 'node:fs'
import * as path from 'node:path'

export interface EngineInfo {
  /** Subdirectory name (e.g. `UE_5.4`, `UE_4.27`). */
  name: string
  /** Absolute path of the engine root (the folder that contains `Engine/`). */
  path: string
  /** Resolved semantic version `<Major>.<Minor>.<Patch>` from `Engine/Build/Build.version`. */
  version: string
  /** Just the major version (4 or 5), for branch-grouped UI display. */
  majorVersion: number
  changelist: number
  branchName: string
  /** Path to `UnrealEditor.exe` (UE5) or `UE4Editor.exe` (UE4) when present, else null. */
  editorExePath: string | null
  /** Free-disk-irrelevant size estimate would require a walk we deliberately skip. */
  hasEditor: boolean
}

interface BuildVersionJson {
  MajorVersion?: number
  MinorVersion?: number
  PatchVersion?: number
  Changelist?: number
  BranchName?: string
}

/**
 * Scan `baseDirs` for Unreal Engine installations. Each top-level entry
 * whose name starts with `UE_` and contains `Engine/Build/Build.version`
 * is treated as one engine. Returns engines sorted by `name` ascending.
 *
 * Designed to be cheap: only stats the version file and the editor
 * executable. Skips entries that don't smell like an engine install.
 */
export async function scanEngines(baseDirs: string[]): Promise<EngineInfo[]> {
  const results: EngineInfo[] = []
  const seenPaths = new Set<string>()

  for (const baseDir of baseDirs) {
    let entries: string[]
    try {
      entries = await fsp.readdir(baseDir)
    } catch {
      continue
    }
    for (const name of entries) {
      if (!name.startsWith('UE_')) continue
      const enginePath = path.join(baseDir, name)
      if (seenPaths.has(enginePath)) continue
      const info = await readEngineInfo(name, enginePath)
      if (info) {
        results.push(info)
        seenPaths.add(enginePath)
      }
    }
  }

  results.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
  return results
}

async function readEngineInfo(name: string, enginePath: string): Promise<EngineInfo | null> {
  const versionFile = path.join(enginePath, 'Engine', 'Build', 'Build.version')
  let raw: string
  try {
    raw = await fsp.readFile(versionFile, 'utf-8')
  } catch {
    return null
  }
  let v: BuildVersionJson
  try {
    v = JSON.parse(raw) as BuildVersionJson
  } catch {
    return null
  }
  const major = v.MajorVersion ?? 0
  const minor = v.MinorVersion ?? 0
  const patch = v.PatchVersion ?? 0
  const version = `${major}.${minor}.${patch}`
  const editorExePath = await findEditorExe(enginePath, major)
  return {
    name,
    path: enginePath,
    version,
    majorVersion: major,
    changelist: v.Changelist ?? 0,
    branchName: v.BranchName ?? '',
    editorExePath,
    hasEditor: editorExePath !== null
  }
}

async function findEditorExe(enginePath: string, major: number): Promise<string | null> {
  const candidates: string[] = []
  if (process.platform === 'win32') {
    candidates.push(
      path.join(enginePath, 'Engine', 'Binaries', 'Win64', major >= 5 ? 'UnrealEditor.exe' : 'UE4Editor.exe')
    )
  } else if (process.platform === 'darwin') {
    candidates.push(
      path.join(
        enginePath,
        'Engine',
        'Binaries',
        'Mac',
        major >= 5 ? 'UnrealEditor.app' : 'UE4Editor.app'
      )
    )
  } else {
    candidates.push(
      path.join(enginePath, 'Engine', 'Binaries', 'Linux', major >= 5 ? 'UnrealEditor' : 'UE4Editor')
    )
  }
  for (const candidate of candidates) {
    try {
      await fsp.access(candidate)
      return candidate
    } catch {
      // not present
    }
  }
  return null
}
