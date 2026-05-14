import { promises as fsp } from 'node:fs'
import * as path from 'node:path'

export interface SetAsTemplateRequest {
  /** Absolute path to the source `.uproject` (the project we're cloning into a template). */
  uprojectPath: string
  /** Absolute path to the target engine root (must end where `<root>/Templates/` lives). */
  engineRoot: string
  /** Folder + uproject base name under `<engineRoot>/Templates/`. Convention: `TP_<Something>`. */
  templateName: string
  /** Shown in the New Project window in the editor; goes into LocalizedDisplayNames. */
  displayName: string
  /** Long-form description below the title in the New Project window. */
  description: string
  /**
   * Categories shown in the project picker (one per line in the UI, collapsed
   * to a deduped list here). Falls back to `Games` when empty so the template
   * still ends up somewhere visible.
   */
  categories: string[]
}

export interface SetAsTemplateResult {
  ok: boolean
  error?: string
  /** Absolute path to the created `<engineRoot>/Templates/<templateName>/` folder. */
  templateDir?: string
  /** Absolute path to the new `<templateName>.uproject` file. */
  uprojectPath?: string
  filesCopied?: number
  bytesCopied?: number
  /** True when an icon + preview image were sourced from the project's `Saved/AutoScreenshot.png`. */
  mediaCopied?: boolean
}

/**
 * Folder names that never belong inside a template — they're either build
 * artefacts (Binaries, Intermediate, Build), per-machine caches (DerivedDataCache),
 * per-session state (Saved, except for the AutoScreenshot we handle explicitly),
 * VCS metadata, or IDE state. Matching is case-insensitive and applies to any
 * folder anywhere in the source tree.
 */
const SKIPPED_FOLDERS = new Set([
  'binaries',
  'build',
  'intermediate',
  'saved',
  'deriveddatacache',
  '.git',
  '.svn',
  '.vs',
  '.idea',
  '.vscode',
  '__pycache__'
])

/**
 * Best-effort sanitisation of a template name. The Unreal editor's project-
 * creation pipeline uses this string as a C++ identifier in templated source
 * files, so we trim to the alphanumeric+underscore subset and require it to
 * start with a letter. Returns `null` on inputs that can't be salvaged.
 */
export function sanitiseTemplateName(raw: string): string | null {
  const cleaned = raw
    .trim()
    .replace(/[^A-Za-z0-9_]/g, '')
    .replace(/^_+/, '')
  if (cleaned.length === 0) return null
  if (!/^[A-Za-z]/.test(cleaned)) return null
  return cleaned
}

/**
 * Build the `Config/TemplateDefs.ini` body. English-only — the Unreal
 * launcher gracefully falls back to the English entries when the active
 * locale isn't listed, so we don't ship the (rarely-needed) ko/ja/zh-Hans
 * translations that the engine's own templates carry.
 *
 * `bThumbnailAsIcon=true` reuses `<TemplateName>.png` for both the small
 * launcher icon and the larger preview tile, which matches the structure
 * the Media folder takes when only an AutoScreenshot is available.
 */
function buildTemplateDefsIni(req: SetAsTemplateRequest): string {
  const cats = (req.categories.length > 0 ? req.categories : ['Games'])
    .map((c) => c.trim())
    .filter((c) => c.length > 0)
  // Escape quotes for the ini's `Text="..."` payloads — naive double-quote
  // doubling matches what the engine accepts in the shipped templates.
  const ini = (s: string): string => s.replace(/"/g, '\\"')
  const sortKey = req.templateName.replace(/^TP_/i, '')
  const lines: string[] = []
  lines.push('[/Script/GameProjectGeneration.TemplateProjectDefs]')
  lines.push('')
  for (const c of cats) lines.push(`Categories=${c}`)
  lines.push('')
  lines.push(`LocalizedDisplayNames=(Language="en",Text="${ini(req.displayName)}")`)
  lines.push(`LocalizedDescriptions=(Language="en",Text="${ini(req.description)}")`)
  lines.push('')
  lines.push('FoldersToIgnore=Binaries')
  lines.push('FoldersToIgnore=Build')
  lines.push('FoldersToIgnore=Intermediate')
  lines.push('FoldersToIgnore=Saved')
  lines.push('FoldersToIgnore=Media')
  lines.push('')
  lines.push('FilesToIgnore="%TEMPLATENAME%.uproject"')
  lines.push('FilesToIgnore="%TEMPLATENAME%.png"')
  lines.push('FilesToIgnore="Config/TemplateDefs.ini"')
  lines.push('FilesToIgnore="Config/config.ini"')
  lines.push('FilesToIgnore="Manifest.json"')
  lines.push('FilesToIgnore="contents.txt"')
  lines.push('')
  lines.push('FolderRenames=(From="Source/%TEMPLATENAME%",To="Source/%PROJECTNAME%")')
  lines.push('FolderRenames=(From="Source/%TEMPLATENAME%Editor",To="Source/%PROJECTNAME%Editor")')
  lines.push('')
  lines.push('FilenameReplacements=(Extensions=("cpp","h","ini","cs"),From="%TEMPLATENAME_UPPERCASE%",To="%PROJECTNAME_UPPERCASE%",bCaseSensitive=true)')
  lines.push('FilenameReplacements=(Extensions=("cpp","h","ini","cs"),From="%TEMPLATENAME_LOWERCASE%",To="%PROJECTNAME_LOWERCASE%",bCaseSensitive=true)')
  lines.push('FilenameReplacements=(Extensions=("cpp","h","ini","cs"),From="%TEMPLATENAME%",To="%PROJECTNAME%",bCaseSensitive=false)')
  lines.push('')
  lines.push('ReplacementsInFiles=(Extensions=("cpp","h","ini","cs"),From="%TEMPLATENAME_UPPERCASE%",To="%PROJECTNAME_UPPERCASE%",bCaseSensitive=true)')
  lines.push('ReplacementsInFiles=(Extensions=("cpp","h","ini","cs"),From="%TEMPLATENAME_LOWERCASE%",To="%PROJECTNAME_LOWERCASE%",bCaseSensitive=true)')
  lines.push('ReplacementsInFiles=(Extensions=("cpp","h","ini","cs"),From="%TEMPLATENAME%",To="%PROJECTNAME%",bCaseSensitive=false)')
  lines.push(`SortKey=${sortKey}`)
  lines.push('')
  lines.push('; Reuses the thumbnail as the small launcher icon — common pattern')
  lines.push('; when the template only has one image asset available.')
  lines.push('bThumbnailAsIcon=true')
  return lines.join('\n') + '\n'
}

/**
 * Promote an on-disk project into a reusable engine template. Top-level
 * steps:
 *   1. Validate the source `.uproject` exists.
 *   2. Compute and reserve `<engineRoot>/Templates/<templateName>/` (refuse
 *      to overwrite — the user picks names explicitly, accidental clobbers
 *      would silently wipe an existing template).
 *   3. Walk the source, copying every file except the ignored folders.
 *   4. Rename the copied `.uproject` to `<templateName>.uproject`.
 *   5. Write `Config/TemplateDefs.ini`.
 *   6. If the source has a `Saved/AutoScreenshot.png`, copy it to
 *      `Media/<templateName>.png` and `Media/<templateName>_Preview.png`.
 *
 * Filesystem errors during the walk are surfaced (we don't half-commit a
 * template), but the Media copy is best-effort — a template without media
 * still works, just shows up without an icon in the project picker.
 */
export async function setAsTemplate(req: SetAsTemplateRequest): Promise<SetAsTemplateResult> {
  const safeName = sanitiseTemplateName(req.templateName)
  if (!safeName) {
    return {
      ok: false,
      error:
        'Template name must start with a letter and contain only ASCII letters, digits or underscores.'
    }
  }

  // Source validation.
  try {
    const s = await fsp.stat(req.uprojectPath)
    if (!s.isFile()) {
      return { ok: false, error: `Source .uproject is not a regular file: ${req.uprojectPath}` }
    }
  } catch (err) {
    return {
      ok: false,
      error: `Source .uproject not found: ${err instanceof Error ? err.message : String(err)}`
    }
  }
  const sourceDir = path.dirname(req.uprojectPath)
  const sourceUprojectName = path.basename(req.uprojectPath)

  // Destination must not exist yet.
  const templatesRoot = path.join(req.engineRoot, 'Templates')
  const templateDir = path.join(templatesRoot, safeName)
  try {
    await fsp.stat(templateDir)
    return {
      ok: false,
      error: `Template folder already exists: ${templateDir}`
    }
  } catch {
    // Good — doesn't exist.
  }
  try {
    await fsp.mkdir(templateDir, { recursive: true })
  } catch (err) {
    return {
      ok: false,
      error: `Could not create template folder: ${err instanceof Error ? err.message : String(err)}`
    }
  }

  // Recursive copy with skipped folders.
  let filesCopied = 0
  let bytesCopied = 0
  try {
    await copyTree(sourceDir, sourceDir, templateDir, (bytes) => {
      filesCopied += 1
      bytesCopied += bytes
    })
  } catch (err) {
    return {
      ok: false,
      error: `Copy failed: ${err instanceof Error ? err.message : String(err)}`
    }
  }

  // Rename the .uproject to match the template name.
  const newUprojectPath = path.join(templateDir, `${safeName}.uproject`)
  const copiedUprojectPath = path.join(templateDir, sourceUprojectName)
  if (copiedUprojectPath !== newUprojectPath) {
    try {
      await fsp.rename(copiedUprojectPath, newUprojectPath)
    } catch (err) {
      return {
        ok: false,
        error: `Could not rename .uproject to ${safeName}.uproject: ${
          err instanceof Error ? err.message : String(err)
        }`
      }
    }
  }

  // Write Config/TemplateDefs.ini, creating Config/ if it's missing
  // (Blueprint-only projects can ship without a Config folder).
  const configDir = path.join(templateDir, 'Config')
  try {
    await fsp.mkdir(configDir, { recursive: true })
    await fsp.writeFile(
      path.join(configDir, 'TemplateDefs.ini'),
      buildTemplateDefsIni({ ...req, templateName: safeName }),
      'utf-8'
    )
  } catch (err) {
    return {
      ok: false,
      error: `Could not write TemplateDefs.ini: ${
        err instanceof Error ? err.message : String(err)
      }`
    }
  }

  // Best-effort media: copy AutoScreenshot.png to <name>.png + _Preview.png.
  // Doesn't fail the operation if the source has no screenshot.
  let mediaCopied = false
  const autoshot = path.join(sourceDir, 'Saved', 'AutoScreenshot.png')
  try {
    await fsp.stat(autoshot)
    const mediaDir = path.join(templateDir, 'Media')
    await fsp.mkdir(mediaDir, { recursive: true })
    await fsp.copyFile(autoshot, path.join(mediaDir, `${safeName}.png`))
    await fsp.copyFile(autoshot, path.join(mediaDir, `${safeName}_Preview.png`))
    mediaCopied = true
  } catch {
    /* no screenshot available — leave Media empty */
  }

  return {
    ok: true,
    templateDir,
    uprojectPath: newUprojectPath,
    filesCopied,
    bytesCopied,
    mediaCopied
  }
}

async function copyTree(
  current: string,
  sourceRoot: string,
  targetRoot: string,
  onFile: (bytes: number) => void
): Promise<void> {
  let entries
  try {
    entries = await fsp.readdir(current, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (SKIPPED_FOLDERS.has(e.name.toLowerCase())) continue
      await copyTree(path.join(current, e.name), sourceRoot, targetRoot, onFile)
      continue
    }
    if (!e.isFile()) continue
    const abs = path.join(current, e.name)
    const rel = path.relative(sourceRoot, abs)
    const dest = path.join(targetRoot, rel)
    await fsp.mkdir(path.dirname(dest), { recursive: true })
    await fsp.copyFile(abs, dest)
    try {
      const s = await fsp.stat(dest)
      onFile(s.size)
    } catch {
      onFile(0)
    }
  }
}
