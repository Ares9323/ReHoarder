import { describe, it, expect } from 'vitest'
import {
  parseIni,
  applyMerge,
  applyOverrideOnlyMerge,
  serializeIni,
  hasSentinel,
  stripSentinelHeader
} from './engine-ini-patcher'

// A master section whose multi-value key (UserDefinedChords) is preceded by a
// documentation comment block. The patcher must keep that comment block exactly
// once, even when the same file is patched again.
const MASTER = [
  ';METADATA=(Diff=true, UseCommands=true)',
  '[UserDefinedChords]',
  '; DisconnectPinLink - clear BA default X',
  '; (frees X for e.g. Niagara DisableSelectedEmitters)',
  'UserDefinedChords=(A)',
  'UserDefinedChords=(B)',
  ''
].join('\r\n')

function patchOnce(engineContent: string): string {
  const engineDoc = parseIni(engineContent)
  const masterDoc = parseIni(MASTER)
  applyMerge(engineDoc, masterDoc)
  return serializeIni(engineDoc)
}

describe('applyMerge re-patch idempotence', () => {
  it('does not duplicate the comment block preceding a multi-value key', () => {
    // First patch onto an empty engine config.
    const firstPass = patchOnce('')
    const firstCount = firstPass.split('; DisconnectPinLink').length - 1
    expect(firstCount).toBe(1)

    // Re-patch the already-patched output.
    const secondPass = patchOnce(firstPass)
    const secondCount = secondPass.split('; DisconnectPinLink').length - 1
    expect(secondCount).toBe(1)

    // The multi-value lines themselves must not duplicate either.
    expect(secondPass.split('UserDefinedChords=(A)').length - 1).toBe(1)
    expect(secondPass.split('UserDefinedChords=(B)').length - 1).toBe(1)

    // Re-patching an unchanged master must be a no-op on meaningful content
    // (ignoring a possible trailing-blank difference from EOF round-tripping).
    expect(secondPass.replace(/(\r?\n)+$/, '')).toBe(firstPass.replace(/(\r?\n)+$/, ''))
  })
})

describe('sentinel handling — legacy UnrealPluginToggler', () => {
  it('recognises the legacy sentinel as "already patched"', () => {
    const legacy =
      '; === Patched by UnrealPluginToggler 2026-05-15T22:29:24 (master: 96cab9b9) ===\r\n\r\n;METADATA\r\n'
    expect(hasSentinel(legacy)).toBe(true)
  })

  it('strips the legacy sentinel and its blank separator', () => {
    const legacy =
      '; === Patched by UnrealPluginToggler 2026-05-15T22:29:24 (master: 96cab9b9) ===\r\n\r\n[Section]\r\nKey=1\r\n'
    const stripped = stripSentinelHeader(legacy)
    expect(stripped).not.toContain('UnrealPluginToggler')
    expect(stripped.startsWith('[Section]')).toBe(true)
  })

  it('strips a stale legacy sentinel even when our header sits above it', () => {
    const both =
      '; === Patched by ReHoarder 2026-05-29T16:00:40 (master: d48ec1f3) ===\r\n\r\n' +
      '; === Patched by UnrealPluginToggler 2026-05-15T22:29:24 (master: 96cab9b9) ===\r\n\r\n' +
      '[Section]\r\nKey=1\r\n'
    const stripped = stripSentinelHeader(both)
    expect(stripped).not.toContain('UnrealPluginToggler')
    expect(stripped).not.toContain('ReHoarder')
    expect(stripped.startsWith('[Section]')).toBe(true)
  })
})

/**
 * Platform-specific ini pass. Unreal loads
 * `Engine/Config/Windows/WindowsEditorPerProjectUserSettings.ini` after the
 * Base file, so Epic's values there win: engines shipping that file set
 * `bEnabled=True` for Live Coding, defeating the `False` our master writes into
 * the Base file.
 */
describe('applyOverrideOnlyMerge', () => {
  const master = parseIni(
    [
      '[/Script/LiveCoding.LiveCodingSettings]',
      'bEnabled=False                  ; default was True',
      '',
      '[/Script/UnrealEd.EditorStyleSettings]',
      'bUseGrid=False',
      '',
      '[/Script/UnrealEd.LevelEditorPlaySettings]',
      '+MonitorScreenResolutions=(Description="HD 16:9",Width=1280,Height=720)',
      '',
      '[/Script/Only.InMaster]',
      'SomeKey=1'
    ].join('\r\n')
  )

  it('realigns a scalar the platform file uses to contradict the master', () => {
    const doc = parseIni(
      '[/Script/LiveCoding.LiveCodingSettings]\r\nbEnabled=True\r\n'
    )
    const r = applyOverrideOnlyMerge(doc, master)
    expect(r.scalarsOverridden).toBe(1)
    expect(serializeIni(doc)).toContain('bEnabled=False')
    expect(serializeIni(doc)).not.toContain('bEnabled=True')
  })

  it('reports no change when the platform file already agrees', () => {
    const doc = parseIni(
      '[/Script/LiveCoding.LiveCodingSettings]\r\nbEnabled=False\r\n'
    )
    expect(applyOverrideOnlyMerge(doc, master).scalarsOverridden).toBe(0)
  })

  it('never adds a section the platform file does not already have', () => {
    const doc = parseIni('[/Script/Some.OtherThing]\r\nFoo=1\r\n')
    const r = applyOverrideOnlyMerge(doc, master)
    expect(r.scalarsOverridden).toBe(0)
    expect(r.sectionsAdded).toBe(0)
    const out = serializeIni(doc)
    expect(out).not.toContain('LiveCoding')
    expect(out).not.toContain('Only.InMaster')
  })

  it('never adds a key to a section it does share', () => {
    const doc = parseIni(
      '[/Script/UnrealEd.EditorStyleSettings]\r\nSomethingElse=1\r\n'
    )
    const r = applyOverrideOnlyMerge(doc, master)
    expect(r.scalarsOverridden).toBe(0)
    expect(serializeIni(doc)).not.toContain('bUseGrid')
  })

  /** The whole reason this isn't just a second applyMerge: Unreal concatenates
   *  `+Key=` entries down the config chain, so copying them here would duplicate
   *  every monitor resolution and chord. */
  it('leaves array entries alone', () => {
    const doc = parseIni(
      [
        '[/Script/UnrealEd.LevelEditorPlaySettings]',
        '+MonitorScreenResolutions=(Description="Platform native",Width=1920,Height=1080)'
      ].join('\r\n')
    )
    const r = applyOverrideOnlyMerge(doc, master)
    expect(r.scalarsOverridden).toBe(0)
    expect(r.arraysReplaced).toBe(0)
    const out = serializeIni(doc)
    expect(out).toContain('Platform native')
    expect(out).not.toContain('HD 16:9')
  })

  it('preserves everything the platform file declares outside the master', () => {
    const doc = parseIni(
      [
        '[/Script/LiveCoding.LiveCodingSettings]',
        'bEnabled=True',
        'Startup=AutomaticButHidden',
        '',
        '[/Script/Untouched.Section]',
        'Keep=Me'
      ].join('\r\n')
    )
    applyOverrideOnlyMerge(doc, master)
    const out = serializeIni(doc)
    expect(out).toContain('Startup=AutomaticButHidden')
    expect(out).toContain('Keep=Me')
    expect(out).toContain('bEnabled=False')
  })
})
