import { promises as fsp } from 'node:fs'
import * as path from 'node:path'
import {
  applyMerge,
  buildSentinelLine,
  computeMasterHash,
  hasSentinel,
  parseIni,
  serializeIni,
  stripSentinelHeader,
  summarisePatchResult,
  type PatchResult
} from './engine-ini-patcher'

/**
 * Path of the engine ini we own + its `.bak` sibling. Hardcoded relative to
 * the engine root — this is the only Base*-style file the master-merge
 * machinery currently targets. Mirrors UnrealPluginToggler's choice.
 */
const ENGINE_INI_REL = path.join('Engine', 'Config', 'BaseEditorPerProjectUserSettings.ini')
const BACKUP_SUFFIX = '.bak'

export function getEngineIniPath(engineRoot: string): string {
  return path.join(engineRoot, ENGINE_INI_REL)
}

export function getBackupPath(engineRoot: string): string {
  return getEngineIniPath(engineRoot) + BACKUP_SUFFIX
}

export interface EditorSettingsInfo {
  /** Absolute path of the engine's BaseEditorPerProjectUserSettings.ini. */
  engineIniPath: string
  /** True iff the file currently on disk carries our sentinel header. */
  hasSentinel: boolean
  /** True iff `<engineIniPath>.bak` exists (Restore is available). */
  hasBackup: boolean
  /** Master hash captured in the sentinel line, when readable. */
  masterHash: string | null
}

/**
 * Cheap status read for the UI: tells whether the engine ini has been
 * patched by us before (sentinel present) and whether a Restore would have
 * a target to copy from.
 */
export async function readEditorSettingsInfo(engineRoot: string): Promise<EditorSettingsInfo> {
  const engineIniPath = getEngineIniPath(engineRoot)
  let sentinel = false
  let masterHash: string | null = null
  try {
    const content = await fsp.readFile(engineIniPath, 'utf-8')
    if (hasSentinel(content)) {
      sentinel = true
      const first = content.split(/\r?\n/, 1)[0] ?? ''
      const m = /master:\s*([0-9a-f]+)/i.exec(first)
      if (m) masterHash = m[1]
    }
  } catch {
    /* missing file is fine — info reflects "no patch yet" */
  }
  let hasBak = false
  try {
    await fsp.access(getBackupPath(engineRoot))
    hasBak = true
  } catch {
    /* no backup */
  }
  return {
    engineIniPath,
    hasSentinel: sentinel,
    hasBackup: hasBak,
    masterHash
  }
}

export interface ApplyEditorSettingsResult {
  ok: boolean
  error?: string
  engineIniPath?: string
  backupPath?: string
  /** True only when this run created the .bak (first clean patch). */
  backupWritten?: boolean
  /** Short summary of what changed (overrides, additions, comments). */
  summary?: string
  patch?: PatchResult
  /** When `dryRun: true` was requested, the proposed merged content (with
   *  the new sentinel) — not written to disk. */
  proposedContent?: string
  /** When `dryRun: true`, the current content as it would have been parsed
   *  (sentinel header stripped) — useful as the "left" side of a diff. */
  currentContent?: string
}

export interface ApplyEditorSettingsOptions {
  /** When true, run the full merge but don't write anything. The result
   *  carries `proposedContent` + `currentContent` so the caller can render a
   *  diff and let the user confirm before a real apply. */
  dryRun?: boolean
}

/**
 * Top-level apply: read master, parse engine ini, merge in place, stamp the
 * sentinel and write atomically. The first run on a clean engine file
 * (no pre-existing sentinel) snapshots the original content to
 * `<engineIniPath>.bak` so Restore always has a target — subsequent runs
 * never overwrite the bak, preserving the user's true "Day 0" baseline.
 */
export async function applyEditorSettings(
  engineRoot: string,
  masterPath: string,
  opts: ApplyEditorSettingsOptions = {}
): Promise<ApplyEditorSettingsResult> {
  let masterContent: string
  try {
    masterContent = await fsp.readFile(masterPath, 'utf-8')
  } catch (err) {
    return {
      ok: false,
      error: `Could not read master at ${masterPath}: ${
        err instanceof Error ? err.message : String(err)
      }`
    }
  }
  const engineIniPath = getEngineIniPath(engineRoot)
  let engineContent = ''
  try {
    engineContent = await fsp.readFile(engineIniPath, 'utf-8')
  } catch {
    /* no engine file yet → treat as empty */
  }

  // Backup planning (no disk action under dry-run). The bak preserves Epic's
  // untouched baseline forever — we never overwrite it once stamped, so the
  // real-apply path checks existence before writing.
  const backupPath = getBackupPath(engineRoot)
  const hadSentinel = hasSentinel(engineContent)
  let backupExists = false
  try {
    await fsp.access(backupPath)
    backupExists = true
  } catch {
    /* none */
  }

  // Strip the old sentinel before parsing so it doesn't end up embedded
  // in the preamble of the merged document (which we'd then double-stamp).
  const cleanEngineContent = hadSentinel ? stripSentinelHeader(engineContent) : engineContent
  const engineDoc = parseIni(cleanEngineContent)
  const masterDoc = parseIni(masterContent)
  const patch = applyMerge(engineDoc, masterDoc)
  const merged = serializeIni(engineDoc)
  const masterHash = computeMasterHash(masterContent)
  const finalContent = buildSentinelLine(masterHash) + '\r\n\r\n' + merged

  if (opts.dryRun) {
    // Return the proposed content for the caller to diff; nothing touches
    // disk so this is a pure preview. `backupWritten` reflects what a real
    // apply *would* do, not what happened, so the dialog can warn the user
    // that a fresh baseline would be captured.
    return {
      ok: true,
      engineIniPath,
      backupPath,
      backupWritten: !hadSentinel && !backupExists && engineContent.length > 0,
      summary: summarisePatchResult(patch),
      patch,
      proposedContent: finalContent,
      currentContent: cleanEngineContent
    }
  }

  // Ensure the parent dir exists — engines that have never opened the editor
  // may not have created `Engine/Config/` themselves (rare, but possible for
  // source-built engines).
  await fsp.mkdir(path.dirname(engineIniPath), { recursive: true })

  let backupWritten = false
  if (!hadSentinel && !backupExists && engineContent.length > 0) {
    await fsp.writeFile(backupPath, engineContent, 'utf-8')
    backupWritten = true
  }

  // Atomic write: tmp + rename. Avoids a half-written ini if the process
  // dies mid-write (Unreal would refuse to start with a truncated config).
  const tmp = engineIniPath + '.tmp'
  await fsp.writeFile(tmp, finalContent, 'utf-8')
  await fsp.rename(tmp, engineIniPath)

  return {
    ok: true,
    engineIniPath,
    backupPath,
    backupWritten,
    summary: summarisePatchResult(patch),
    patch
  }
}

/**
 * Annotated master template the user can save and start editing. Documents
 * the three merge modes (verbatim section, scalar override, array replace),
 * the `@ReHoarder:` directives, and a couple of real-world examples that
 * demonstrate the pattern without being so opinionated they become a
 * "ReHoarder house style" the user would have to undo first.
 */
/**
 * Curated "Ares recommended" master — the same settings the original
 * UnrealPluginToggler ships in its `Masters/EditorPerProjectUserSettings.ini`,
 * directives swapped to ReHoarder's prefix. Bundled as an opt-in alternative
 * to the empty starter template so users who want a battle-tested baseline
 * can grab it in one click.
 */
export const ARES_RECOMMENDED_MASTER = `; ==============================================================================
; Master for BaseEditorPerProjectUserSettings.ini — Ares' curated baseline
; Bundled with ReHoarder as an opt-in starting point. Edit freely.
; ==============================================================================

; -------- Disable Epic's default spawn-node shortcuts --------

; @ReHoarder: CommentAll
[BlueprintSpawnNodes]

; @ReHoarder: CommentAll
[MaterialEditorSpawnNodes]
+Node=(Class=/Script/Engine.MaterialExpressionReroute Key=R Shift=true Ctrl=false Alt=false)

; -------- Epic sections to override --------

[/Script/UnrealEd.EditorStyleSettings]
bUseGrid=False                                  ; default was True

[/Script/UnrealEd.EditorLoadingSavingSettings]
LoadLevelAtStartup=LastOpened                   ; default was ProjectDefault
bAutoSaveEnable=False                           ; default was True

[/Script/UnrealEd.LevelEditorPlaySettings]
; common monitor resolutions with standard naming
+MonitorScreenResolutions=(Description="HD 16:9",Width=1280,Height=720,AspectRatio="16:9",bCanSwapAspectRatio=true)
+MonitorScreenResolutions=(Description="Full HD 16:9",Width=1920,Height=1080,AspectRatio="16:9",bCanSwapAspectRatio=true)
+MonitorScreenResolutions=(Description="Full HD 16:10",Width=1920,Height=1200,AspectRatio="16:10",bCanSwapAspectRatio=true)
+MonitorScreenResolutions=(Description="QHD / 2K 16:9",Width=2560,Height=1440,AspectRatio="16:9",bCanSwapAspectRatio=true)
+MonitorScreenResolutions=(Description="QHD / 2K 21:9",Width=3440,Height=1440,AspectRatio="21:9",bCanSwapAspectRatio=true)
+MonitorScreenResolutions=(Description="4K UHD 16:9",Width=3840,Height=2160,AspectRatio="16:9",bCanSwapAspectRatio=true)
+MonitorScreenResolutions=(Description="4K UHD 16:10",Width=3840,Height=2400,AspectRatio="16:10",bCanSwapAspectRatio=true)
+MonitorScreenResolutions=(Description="5K 16:9",Width=5120,Height=2880,AspectRatio="16:9",bCanSwapAspectRatio=true)

[/Script/AssetManagerEditor.ReferenceViewerSettings]
bIsShowFilteredPackagesOnly=False               ; default was True

; -------- Added sections --------

[/Script/UnrealEd.EditorPerformanceSettings]
bShowFrameRateAndMemory=True

[/Script/GraphEditor.GraphEditorSettings]
DefaultCommentNodeTitleColor=(R=0.291771,G=0.016807,B=0.423268,A=1.000000)
bShowCommentBubbleWhenZoomedOut=True

[/Script/BlueprintGraph.BlueprintEditorSettings]
bFlattenFavoritesMenus=True
bShowContextualFavorites=True
SaveOnCompile=SoC_SuccessOnly
NodeTemplateCacheCapMB=50.000000
bShowInheritedVariables=True
bAlwaysShowInterfacesInOverrides=True
bShowParentClassInOverrides=True
bEnableInputTriggerSupportWarnings=True
bAutoCastObjectConnections=True
bHideConstructionScriptComponentsInDetailsView=False
bHostFindInBlueprintsInGlobalTab=True
bAllowExplicitImpureNodeDisabling=True

[/Script/SourceCodeAccess.SourceCodeAccessSettings]
PreferredAccessor=Rider

[/Script/BlueprintAssist.BASettings]
bGloballyDisableAutoFormatting=True
ParameterStyle=LeftSide
BlueprintFormatterSettings=(bEnabled=True,FormatterType=Blueprint,Padding=(X=100,Y=100),AutoFormatting=Never,FormatterDirection=EGPD_Output,RootNodes=("K2Node_Tunnel"),ExecPinName="exec")

[/Script/BlueprintAssist.BASettings_Advanced]
bForceRefreshGraphAfterFormatting=True

[/Script/BlueprintAssist.BASettings_EditorFeatures]
bShowWelcomeScreenOnLaunch=False

[/Script/DarkerNodes.DarkerNodesSettings]
MasterActivate=True
UseGlobalSettings=True
KeepDefaultCommentColor=True
ActivatePopupOnUpdate=False
`

export type MasterTemplateVariant = 'basic' | 'aresRecommended'

export function pickMasterTemplate(variant: MasterTemplateVariant): string {
  return variant === 'aresRecommended' ? ARES_RECOMMENDED_MASTER : MASTER_TEMPLATE
}

export const MASTER_TEMPLATE = `; ==============================================================================
; Master for BaseEditorPerProjectUserSettings.ini
; Applied by ReHoarder's "Apply editor settings master" action to every
; configured engine's Engine\\Config\\BaseEditorPerProjectUserSettings.ini.
;
; Every section / key you write below is interpreted as:
;   - Section NOT in Epic's ini      -> appended verbatim
;   - Scalar Key=Value               -> overrides (or adds) the key in that Epic section
;   - +Key=Value (array add)         -> removes ALL existing +Key= lines for that key,
;                                       then inserts yours; same rule when you simply
;                                       repeat a plain Key=Value line.
;
; Explicit directives (place the comment IMMEDIATELY above the section header,
; with no blank lines between them):
;   ; @ReHoarder: CommentAll    -> comment every Epic entry in that section.
;                                  The body (if any) you write under the header
;                                  is appended uncommented.
;   ; @ReHoarder: AppendArray   -> reserved for a future release; emits a warning.
;
; The first time you Apply on a clean engine, the original Epic file is copied
; to BaseEditorPerProjectUserSettings.ini.bak — Restore reverts to that snapshot.
; ==============================================================================

; -------- Example: scalar overrides on an existing Epic section --------
; (delete this block once you have your own overrides)

[/Script/UnrealEd.EditorStyleSettings]
bUseGrid=False                                  ; ReHoarder - default was True
HoveredBrushTintColor=(R=1.0,G=1.0,B=1.0,A=0.05)

; -------- Example: wipe a whole Epic section, then add our own entries --------
; Useful when Epic ships keybindings / hotkeys you want gone entirely.

; @ReHoarder: CommentAll
[BlueprintSpawnNodes]
; (leave the body empty to simply wipe the section, or list your own
;  +Node=(...) lines here to replace Epic's defaults)

; -------- Example: add a brand-new section Epic doesn't ship --------
; Treated as "append verbatim". No Epic equivalent to merge against.

[/Script/MyTeam.MyTeamProjectSettings]
bSnapToGridByDefault=True
DefaultBuildConfiguration="Development"
`

export interface RestoreEditorSettingsResult {
  ok: boolean
  error?: string
  engineIniPath?: string
}

/**
 * Copy the captured `.bak` back over the patched engine ini. Fails loudly
 * when there's nothing to restore from (the user can re-create a baseline
 * via Epic Launcher's Verify, then re-Apply once to plant the bak).
 */
export async function restoreEditorSettings(
  engineRoot: string
): Promise<RestoreEditorSettingsResult> {
  const engineIniPath = getEngineIniPath(engineRoot)
  const backupPath = getBackupPath(engineRoot)
  try {
    await fsp.access(backupPath)
  } catch {
    return {
      ok: false,
      error:
        `No baseline backup at ${backupPath}. The .bak is created automatically on the first ` +
        `Apply against an unpatched engine — run Epic Launcher's Verify to restore Epic's ` +
        `baseline, then Apply once so we can capture it.`
    }
  }
  await fsp.mkdir(path.dirname(engineIniPath), { recursive: true })
  const tmp = engineIniPath + '.tmp'
  await fsp.copyFile(backupPath, tmp)
  await fsp.rename(tmp, engineIniPath)
  return { ok: true, engineIniPath }
}
