import { describe, it, expect } from 'vitest'
import { fabWebChip } from './fab-web-chip'

describe('fabWebChip', () => {
  it('shows a passive label when signed in', () => {
    expect(fabWebChip('logged-in', false, false)).toEqual({
      label: 'Fab: signed in',
      clickable: false,
      highlight: false
    })
  })

  it('offers sign in when logged out, highlighted after a sync skipped entitlements', () => {
    expect(fabWebChip('logged-out', false, false)).toEqual({
      label: 'Fab: sign in',
      clickable: true,
      highlight: false
    })
    expect(fabWebChip('logged-out', false, true).highlight).toBe(true)
  })

  it('offers sign in when the status is unknown', () => {
    expect(fabWebChip('unknown', false, false).clickable).toBe(true)
  })

  it('shows a busy label while signing in or checking', () => {
    expect(fabWebChip('logged-out', true, true)).toEqual({
      label: 'Fab: signing in…',
      clickable: false,
      highlight: false
    })
  })

  it('shows a neutral label before the first status check', () => {
    expect(fabWebChip(null, false, false)).toEqual({
      label: 'Fab: checking…',
      clickable: false,
      highlight: false
    })
  })
})
