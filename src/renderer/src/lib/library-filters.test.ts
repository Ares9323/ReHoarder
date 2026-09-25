import { describe, it, expect } from 'vitest'
import {
  addedSinceToTimestamp,
  DEFAULT_SORT,
  licenseLabel,
  parseSort,
  SORT_OPTIONS
} from './library-filters'

const DAY = 24 * 60 * 60 * 1000

describe('parseSort', () => {
  it('accepts every offered sort value', () => {
    for (const o of SORT_OPTIONS) expect(parseSort(o.value)).toBe(o.value)
  })

  it('falls back to title A-Z on missing or stale values', () => {
    expect(DEFAULT_SORT).toBe('title-asc')
    expect(parseSort(null)).toBe('title-asc')
    expect(parseSort('')).toBe('title-asc')
    expect(parseSort('popularity')).toBe('title-asc')
  })
})

describe('addedSinceToTimestamp', () => {
  const now = 1_000 * DAY
  it('maps presets to a lower bound and "all time" to undefined', () => {
    expect(addedSinceToTimestamp('', now)).toBeUndefined()
    expect(addedSinceToTimestamp('24h', now)).toBe(now - DAY)
    expect(addedSinceToTimestamp('7d', now)).toBe(now - 7 * DAY)
    expect(addedSinceToTimestamp('30d', now)).toBe(now - 30 * DAY)
    expect(addedSinceToTimestamp('6m', now)).toBe(now - 182 * DAY)
    expect(addedSinceToTimestamp('12m', now)).toBe(now - 365 * DAY)
  })
})

describe('licenseLabel', () => {
  it('uses Fab labels and falls back to the slug', () => {
    expect(licenseLabel('legacy-uem')).toBe('UE Marketplace License')
    expect(licenseLabel('personal')).toBe('Personal')
    expect(licenseLabel('something-new')).toBe('something-new')
  })
})
