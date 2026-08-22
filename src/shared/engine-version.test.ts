import { describe, it, expect } from 'vitest'
import { parseEngineVersion, isEngineCompatible } from './engine-version'

describe('parseEngineVersion', () => {
  it('parses major.minor', () => {
    expect(parseEngineVersion('5.7')).toEqual({ major: 5, minor: 7 })
    expect(parseEngineVersion('4.27')).toEqual({ major: 4, minor: 27 })
  })
  it('ignores a patch component', () => {
    expect(parseEngineVersion('5.4.2')).toEqual({ major: 5, minor: 4 })
  })
  it('returns null for a GUID, empty, or non-numeric input', () => {
    expect(parseEngineVersion('{1B4E28BA-2FA1-11D2-883F-0016D3CCA427}')).toBeNull()
    expect(parseEngineVersion('')).toBeNull()
    expect(parseEngineVersion('nope')).toBeNull()
    expect(parseEngineVersion(null)).toBeNull()
    expect(parseEngineVersion(undefined)).toBeNull()
  })
  it('treats a bare major as minor 0', () => {
    expect(parseEngineVersion('5')).toEqual({ major: 5, minor: 0 })
  })
})

describe('isEngineCompatible', () => {
  it('accepts an equal target', () => {
    expect(isEngineCompatible('5.7', '5.7')).toBe(true)
  })
  it('accepts a newer target (minor and major)', () => {
    expect(isEngineCompatible('5.7', '5.8')).toBe(true)
    expect(isEngineCompatible('4.27', '5.0')).toBe(true)
  })
  it('rejects an older target (minor and major)', () => {
    expect(isEngineCompatible('5.7', '5.6')).toBe(false)
    expect(isEngineCompatible('5.0', '4.27')).toBe(false)
  })
  it('rejects an unparsable target', () => {
    expect(isEngineCompatible('5.7', '')).toBe(false)
    expect(isEngineCompatible('5.7', '{GUID}')).toBe(false)
    expect(isEngineCompatible('5.7', null)).toBe(false)
  })
  it('rejects when the required version is unparsable', () => {
    expect(isEngineCompatible('', '5.7')).toBe(false)
    expect(isEngineCompatible(null, '5.7')).toBe(false)
  })
  it('orders by minor number, not lexically', () => {
    // "5.10" >= "5.9" numerically, even though "10" < "9" as strings.
    expect(isEngineCompatible('5.9', '5.10')).toBe(true)
    expect(isEngineCompatible('5.10', '5.9')).toBe(false)
  })
})
