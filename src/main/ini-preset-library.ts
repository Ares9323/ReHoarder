import { app } from 'electron'
import { promises as fsp } from 'node:fs'
import * as path from 'node:path'

/**
 * Generic INI-preset library — shared between editor-settings and keybindings
 * masters. Built-in `.ini` templates live in `resources/presets/<subdir>/` and
 * carry their metadata in leading comment lines:
 *
 *   ; @label My preset
 *   ; @description One-line subtitle shown in the chooser
 *
 * Both directives are optional; missing label falls back to the file's id
 * (basename without `.ini`).
 *
 * The chooser hands a chosen id back to `useIniPreset`, which copies the
 * bundled INI verbatim into the user's master-file location and stamps that
 * path as the active master in settings (done by the IPC caller).
 */

export interface IniPresetMeta {
  /** Stable id (filename without `.ini`) used by the IPC. */
  id: string
  label: string
  description: string | null
  /** Optional unit count surfaced in the chooser. `null` hides the column. */
  count: number | null
}

/** Resolve the bundled presets root; dev vs packaged differ. */
function builtInRoot(): string {
  if (app.isPackaged) return path.join(process.resourcesPath, 'presets')
  return path.join(app.getAppPath(), 'resources', 'presets')
}

/**
 * Read the first ~40 lines of an INI file and extract any
 * `; @label …` / `; @description …` directives. Returns the partial metadata
 * — the caller fills the remaining fields (id, count).
 */
function parseHeaderMetadata(content: string): { label?: string; description?: string } {
  const out: { label?: string; description?: string } = {}
  const lines = content.split(/\r?\n/, 40)
  for (const raw of lines) {
    const trimmed = raw.trim()
    if (trimmed.length === 0) continue
    if (!trimmed.startsWith(';')) {
      // First non-comment line ends the header window — directives must live
      // up top, before content, so the file stays diff-friendly.
      break
    }
    const m = /^;\s*@(label|description)\s+(.+?)\s*$/i.exec(trimmed)
    if (!m) continue
    const key = m[1].toLowerCase()
    if (key === 'label' && !out.label) out.label = m[2]
    else if (key === 'description' && !out.description) out.description = m[2]
  }
  return out
}

export type CountFn = (content: string) => number | null

export async function listIniPresets(subdir: string, countFn?: CountFn): Promise<IniPresetMeta[]> {
  const dir = path.join(builtInRoot(), subdir)
  let entries: string[]
  try {
    entries = await fsp.readdir(dir)
  } catch {
    return []
  }
  const out: IniPresetMeta[] = []
  for (const name of entries) {
    if (!name.toLowerCase().endsWith('.ini')) continue
    const abs = path.join(dir, name)
    try {
      const content = await fsp.readFile(abs, 'utf-8')
      const meta = parseHeaderMetadata(content)
      const id = name.replace(/\.ini$/i, '')
      out.push({
        id,
        label: meta.label && meta.label.trim().length > 0 ? meta.label : id,
        description: meta.description ?? null,
        count: countFn ? countFn(content) : null
      })
    } catch {
      /* skip unreadable file */
    }
  }
  // Empty first when present, then alphabetical by label.
  out.sort((a, b) => {
    if (a.id === 'empty') return -1
    if (b.id === 'empty') return 1
    return a.label.localeCompare(b.label)
  })
  return out
}

export interface UseIniPresetResult {
  ok: boolean
  error?: string
  /** Absolute path of the master file the template was written to. */
  path?: string
}

/**
 * Copy the bundled INI identified by `id` to `dest`. The metadata directives
 * (`; @label`, `; @description`) are stripped on the way through so the
 * landing file looks clean to the user — they only had value during library
 * listing. Caller is responsible for stamping the destination path into the
 * relevant settings field.
 */
export async function useIniPreset(opts: {
  subdir: string
  dest: string
  id: string
}): Promise<UseIniPresetResult> {
  const { subdir, dest, id } = opts
  if (!/^[A-Za-z0-9._-]+$/.test(id)) {
    return { ok: false, error: 'Invalid preset id' }
  }
  const src = path.join(builtInRoot(), subdir, `${id}.ini`)
  let content: string
  try {
    content = await fsp.readFile(src, 'utf-8')
  } catch (err) {
    return {
      ok: false,
      error: `Could not read built-in preset: ${err instanceof Error ? err.message : String(err)}`
    }
  }
  const cleaned = stripHeaderDirectives(content)
  try {
    await fsp.mkdir(path.dirname(dest), { recursive: true })
    const tmp = dest + '.tmp'
    await fsp.writeFile(tmp, cleaned, 'utf-8')
    await fsp.rename(tmp, dest)
  } catch (err) {
    return {
      ok: false,
      error: `Could not write preset: ${err instanceof Error ? err.message : String(err)}`
    }
  }
  return { ok: true, path: dest }
}

/**
 * Drop the leading `; @label …` / `; @description …` lines (only those — any
 * other comment is preserved). Stops at the first non-directive content so
 * mid-file `;` comments are untouched.
 */
function stripHeaderDirectives(content: string): string {
  const lines = content.split(/\r?\n/)
  let drop = 0
  for (const raw of lines) {
    const trimmed = raw.trim()
    if (trimmed.length === 0) {
      drop++
      continue
    }
    if (/^;\s*@(label|description)\s+/i.test(trimmed)) {
      drop++
      continue
    }
    break
  }
  return lines.slice(drop).join('\r\n')
}

// -------- Count functions for specific subdirs --------

/** Number of `UserDefinedChords=` lines outside comment context. */
export function countKeybindingsChords(content: string): number {
  let n = 0
  for (const raw of content.split(/\r?\n/)) {
    const trimmed = raw.trimStart()
    if (trimmed.startsWith(';') || trimmed.startsWith('#')) continue
    if (/^UserDefinedChords\s*=/.test(trimmed)) n++
  }
  return n
}

/**
 * Number of key=value lines (overrides or appends) outside comment / section
 * headers — a useful proxy for "how much does this preset patch".
 */
export function countEditorSettingsOverrides(content: string): number {
  let n = 0
  for (const raw of content.split(/\r?\n/)) {
    const trimmed = raw.trimStart()
    if (trimmed.length === 0) continue
    if (trimmed.startsWith(';') || trimmed.startsWith('#')) continue
    if (trimmed.startsWith('[')) continue
    if (trimmed.includes('=')) n++
  }
  return n
}
