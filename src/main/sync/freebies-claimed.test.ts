import { describe, it, expect } from 'vitest'
import { applyClaimedFlags, countUnclaimed } from './freebies-claimed'
import type { FabFreebie } from '../fab/fab-freebies'

function fb(uid: string): FabFreebie {
  return { uid, title: uid, imageUrl: null, productUrl: `https://fab/${uid}` }
}

describe('applyClaimedFlags', () => {
  it('marks a freebie claimed iff its uid is in the set', () => {
    const list = [fb('A'), fb('B')]
    applyClaimedFlags(list, new Set(['A']))
    expect(list[0].claimed).toBe(true)
    expect(list[1].claimed).toBe(false)
  })

  it('marks everything unclaimed for an empty set', () => {
    const list = [fb('A'), fb('B')]
    applyClaimedFlags(list, new Set())
    expect(list.every((f) => f.claimed === false)).toBe(true)
  })
})

describe('countUnclaimed', () => {
  it('counts freebies whose claimed flag is not true', () => {
    const list = [fb('A'), fb('B'), fb('C')]
    applyClaimedFlags(list, new Set(['A']))
    expect(countUnclaimed(list)).toBe(2)
  })

  it('given claimedUids {A} and set {A,B} yields unclaimedCount 1', () => {
    const list = [fb('A'), fb('B')]
    applyClaimedFlags(list, new Set(['A']))
    expect(list.find((f) => f.uid === 'A')!.claimed).toBe(true)
    expect(list.find((f) => f.uid === 'B')!.claimed).toBe(false)
    expect(countUnclaimed(list)).toBe(1)
  })
})
