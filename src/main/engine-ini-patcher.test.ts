import { describe, it, expect } from 'vitest'
import {
  parseIni,
  applyMerge,
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
