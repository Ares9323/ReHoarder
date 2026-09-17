import { describe, it, expect } from 'vitest'
import {
  clampCardWidth,
  columnsFor,
  widthForColumns,
  zoomStep,
  MIN_CARD_WIDTH,
  MAX_CARD_WIDTH,
  MAX_COLUMNS
} from './grid-zoom'

const GAP = 16

describe('columnsFor', () => {
  it('counts how many cards fit, accounting for the n-1 gaps', () => {
    // 1000px of content, 200px cards, 16px gaps → 4 cards + 3 gaps = 848 ≤ 1000,
    // a 5th would need 1048.
    expect(columnsFor(1000, GAP, 200)).toBe(4)
  })

  it('never reports fewer than one column, even when a card overflows', () => {
    expect(columnsFor(200, GAP, 720)).toBe(1)
    expect(columnsFor(0, GAP, 200)).toBe(1)
  })

  it('handles a zero gap', () => {
    expect(columnsFor(1000, 0, 250)).toBe(4)
  })
})

describe('widthForColumns', () => {
  it('returns a width that actually yields the requested column count', () => {
    for (const inner of [640, 1000, 1017, 1280, 1913, 2560]) {
      for (const cols of [1, 2, 3, 5, 8, 12]) {
        const w = widthForColumns(inner, GAP, cols)
        // Only meaningful when the clamp didn't kick in — at the boundaries the
        // requested count is simply unreachable.
        if (w > MIN_CARD_WIDTH && w < MAX_CARD_WIDTH) {
          expect(columnsFor(inner, GAP, w)).toBe(cols)
        }
      }
    }
  })

  it('clamps to the readable range', () => {
    expect(widthForColumns(4000, GAP, 40)).toBe(MIN_CARD_WIDTH)
    expect(widthForColumns(4000, GAP, 1)).toBe(MAX_CARD_WIDTH)
  })
})

describe('clampCardWidth', () => {
  it('floors instead of rounding up', () => {
    // 322.67 must not become 323: at inner=1000/gap=16 that would drop the
    // grid from 3 columns to 2.
    expect(clampCardWidth(322.67)).toBe(322)
    expect(columnsFor(1000, GAP, clampCardWidth(322.67))).toBe(3)
  })

  it('holds the bounds', () => {
    expect(clampCardWidth(10)).toBe(MIN_CARD_WIDTH)
    expect(clampCardWidth(9999)).toBe(MAX_CARD_WIDTH)
  })
})

describe('zoomStep', () => {
  it('zooming in removes exactly one column', () => {
    const start = 200
    expect(columnsFor(1000, GAP, start)).toBe(4)
    const step = zoomStep(1000, GAP, start, 1)
    expect(step.columns).toBe(3)
  })

  it('zooming out adds exactly one column', () => {
    const step = zoomStep(1000, GAP, 322, -1)
    expect(step.columns).toBe(4)
  })

  it('is reversible in column terms', () => {
    let width = 240
    const inner = 1440
    const before = columnsFor(inner, GAP, width)
    width = zoomStep(inner, GAP, width, 1).cardWidth
    width = zoomStep(inner, GAP, width, -1).cardWidth
    expect(columnsFor(inner, GAP, width)).toBe(before)
  })

  it('stops at one column when zooming in repeatedly', () => {
    let width = 200
    for (let i = 0; i < 20; i++) {
      width = zoomStep(1200, GAP, width, 1).cardWidth
    }
    expect(columnsFor(1200, GAP, width)).toBe(1)
    expect(width).toBeLessThanOrEqual(MAX_CARD_WIDTH)
  })

  it('stops at the minimum card width when zooming out repeatedly', () => {
    let width = 380
    for (let i = 0; i < 40; i++) {
      width = zoomStep(1200, GAP, width, -1).cardWidth
    }
    expect(width).toBe(MIN_CARD_WIDTH)
    expect(columnsFor(1200, GAP, width)).toBeLessThanOrEqual(MAX_COLUMNS + 1)
  })

  it('reports the column count it really produced, not the one it aimed for', () => {
    // Already at one column and zooming in further: the target stays 1.
    const step = zoomStep(600, GAP, 600, 1)
    expect(step.columns).toBe(1)
  })
})
