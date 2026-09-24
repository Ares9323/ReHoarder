import { describe, it, expect } from 'vitest'
import { shortBuildNumber, vaultVersionLabel } from './vault-version'

const BUILD = '5.7.0-48201490+++UE5+Dev-Marketplace-Windows'

describe('shortBuildNumber', () => {
  it('extracts the number after the first dash', () => {
    expect(shortBuildNumber(BUILD)).toBe('48201490')
  })
  it('returns the raw string when the shape is unknown', () => {
    expect(shortBuildNumber('custom')).toBe('custom')
  })
})

describe('vaultVersionLabel', () => {
  it('joins engine and build', () => {
    expect(vaultVersionLabel('5.7', BUILD)).toBe('UE 5.7 · build 48201490')
  })
  it('shows whichever part is known', () => {
    expect(vaultVersionLabel('5.4', null)).toBe('UE 5.4')
    expect(vaultVersionLabel(null, BUILD)).toBe('build 48201490')
  })
  it('returns null when nothing is known', () => {
    expect(vaultVersionLabel(null, null)).toBeNull()
  })
})
