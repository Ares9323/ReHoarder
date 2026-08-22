import { describe, it, expect } from 'vitest'
import { decideAutoCheck, diffNewUids } from './auto-check'

const DAY = 86_400_000

describe('decideAutoCheck', () => {
  it('is not within cap when there is no prior check', () => {
    expect(decideAutoCheck({ lastAutoSyncAt: null, now: 1000 }).withinCap).toBe(false)
  })

  it('is within cap under 7 days', () => {
    const now = 100 * DAY
    expect(decideAutoCheck({ lastAutoSyncAt: now - 3 * DAY, now }).withinCap).toBe(true)
  })

  it('is not within cap at exactly 7 days', () => {
    const now = 100 * DAY
    expect(decideAutoCheck({ lastAutoSyncAt: now - 7 * DAY, now }).withinCap).toBe(false)
  })

  it('is not within cap past 7 days', () => {
    const now = 100 * DAY
    expect(decideAutoCheck({ lastAutoSyncAt: now - 10 * DAY, now }).withinCap).toBe(false)
  })
})

describe('diffNewUids', () => {
  it('returns uids not in the last-seen set', () => {
    expect(diffNewUids(['A', 'B', 'C'], new Set(['A'])).sort()).toEqual(['B', 'C'])
  })

  it('returns empty when the set is unchanged', () => {
    expect(diffNewUids(['A', 'B'], new Set(['A', 'B']))).toEqual([])
  })

  it('treats a fresh (empty last-seen) check as all-new', () => {
    expect(diffNewUids(['A', 'B'], new Set()).sort()).toEqual(['A', 'B'])
  })
})
