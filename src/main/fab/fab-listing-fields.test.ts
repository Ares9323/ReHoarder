import { describe, it, expect } from 'vitest'
import {
  fabListingUidFromItem,
  engineVersionsFromItem,
  compareEngineVersionsDesc,
  parseFabTimestamp,
  toJsonArrayOrNull,
  parseJsonStringArray
} from './fab-listing-fields'

describe('fabListingUidFromItem', () => {
  it('prefers customAttributes[].ListingIdentifier', () => {
    expect(
      fabListingUidFromItem({
        customAttributes: [{ Other: 'x' }, { ListingIdentifier: 'uid-ca' }],
        url: 'https://www.fab.com/listings/uid-url'
      })
    ).toBe('uid-ca')
  })

  it('falls back to the last path segment of url', () => {
    expect(fabListingUidFromItem({ url: 'https://www.fab.com/listings/uid-url/' })).toBe('uid-url')
  })

  it('returns null when nothing usable is present', () => {
    expect(fabListingUidFromItem({})).toBeNull()
    expect(fabListingUidFromItem({ customAttributes: [{ ListingIdentifier: '' }] })).toBeNull()
  })
})

describe('engineVersionsFromItem', () => {
  it('strips UE_, dedupes across projectVersions and sorts newest first', () => {
    expect(
      engineVersionsFromItem({
        projectVersions: [
          { engineVersions: ['UE_5.3', 'UE_5.10'] },
          { engineVersions: ['UE_5.3', 'UE_5.9', 'UE_4.27'] }
        ]
      })
    ).toEqual(['5.10', '5.9', '5.3', '4.27'])
  })

  it('ignores malformed entries', () => {
    expect(
      engineVersionsFromItem({ projectVersions: [null, { engineVersions: [42, '', 'UE_5.1'] }] })
    ).toEqual(['5.1'])
    expect(engineVersionsFromItem({})).toEqual([])
  })
})

describe('compareEngineVersionsDesc', () => {
  it('compares numerically, newest first', () => {
    expect(['5.9', '4.27', '5.10'].sort(compareEngineVersionsDesc)).toEqual(['5.10', '5.9', '4.27'])
  })
})

describe('parseFabTimestamp', () => {
  it('parses ISO strings with microseconds and offset', () => {
    expect(parseFabTimestamp('2026-06-02T14:57:08.745696+00:00')).toBe(
      Date.UTC(2026, 5, 2, 14, 57, 8, 745)
    )
  })

  it('returns null for missing or garbage input', () => {
    expect(parseFabTimestamp(undefined)).toBeNull()
    expect(parseFabTimestamp('')).toBeNull()
    expect(parseFabTimestamp('not a date')).toBeNull()
    expect(parseFabTimestamp(123)).toBeNull()
  })
})

describe('JSON array helpers', () => {
  it('serializes non-empty arrays and maps empty to null', () => {
    expect(toJsonArrayOrNull(['a', 'b'])).toBe('["a","b"]')
    expect(toJsonArrayOrNull([])).toBeNull()
  })

  it('parses only arrays of strings, tolerating bad input', () => {
    expect(parseJsonStringArray('["a","b"]')).toEqual(['a', 'b'])
    expect(parseJsonStringArray(null)).toEqual([])
    expect(parseJsonStringArray('{oops')).toEqual([])
    expect(parseJsonStringArray('[1,"x"]')).toEqual(['x'])
  })
})
