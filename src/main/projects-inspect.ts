import { promises as fsp } from 'node:fs'
import * as path from 'node:path'

export interface InspectedProject {
  name: string
  uprojectPath: string
  projectDir: string
  engineAssociation: string
}

export interface InspectProjectFolderResult {
  ok: boolean
  error?: string
  project?: InspectedProject | null
}

/** Parse the `.uproject` to read its `EngineAssociation` (`"5.7"` / `"4.27"` / `"{GUID}"` / `""`). */
async function readEngineAssociation(uprojectPath: string): Promise<string> {
  const raw = await fsp.readFile(uprojectPath, 'utf-8')
  const j = JSON.parse(raw) as { EngineAssociation?: string }
  return j.EngineAssociation ?? ''
}

/**
 * Inspect a user-chosen folder for an Unreal project: look for a `*.uproject`
 * among its immediate children (no recursion) and, if found, read its
 * EngineAssociation. Used by the "custom folder" picker in Add-to-project,
 * where the folder isn't necessarily inside any configured project root.
 */
export async function inspectProjectFolder(dir: string): Promise<InspectProjectFolderResult> {
  try {
    const resolved = path.resolve(dir)
    const entries = await fsp.readdir(resolved, { withFileTypes: true })
    const uprojectEntry = entries.find(
      (e) => e.isFile() && e.name.toLowerCase().endsWith('.uproject')
    )
    if (!uprojectEntry) {
      return { ok: true, project: null }
    }
    const uprojectPath = path.join(resolved, uprojectEntry.name)
    const engineAssociation = await readEngineAssociation(uprojectPath)
    return {
      ok: true,
      project: {
        name: path.basename(uprojectEntry.name, '.uproject'),
        uprojectPath,
        projectDir: resolved,
        engineAssociation
      }
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}
