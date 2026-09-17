/**
 * Column math for the Assets grid zoom (Ctrl+wheel / Ctrl+±).
 *
 * The grid lays out with `repeat(auto-fill, minmax(<cardWidth>, 1fr))`, so we
 * never pin a column count — we solve for the *minimum card width* that makes
 * `auto-fill` produce the column count we want. That keeps the grid responsive:
 * resizing the window still reflows, it just reflows around the zoomed size.
 *
 * Extracted from the component because the flooring rules below are easy to get
 * subtly wrong (round instead of floor, and one zoom step lands a column off).
 */

/** Below this a card is unreadable; above it one card fills most screens. */
export const MIN_CARD_WIDTH = 130
export const MAX_CARD_WIDTH = 720
export const MAX_COLUMNS = 12

/**
 * Floors rather than rounds: the value is a *minimum* fed to `minmax()`, and
 * rounding up can push `auto-fill` down to one column fewer than asked for.
 */
export function clampCardWidth(n: number): number {
  return Math.floor(Math.min(MAX_CARD_WIDTH, Math.max(MIN_CARD_WIDTH, n)))
}

/**
 * How many columns `auto-fill` fits, given the grid's content-box width.
 *
 *     columns = floor((inner + gap) / (cardWidth + gap))
 *
 * (the `+ gap` on both sides accounts for there being one fewer gap than
 * columns). Always at least 1 — a single card overflows rather than vanishing.
 */
export function columnsFor(inner: number, gap: number, cardWidth: number): number {
  if (inner <= 0 || cardWidth <= 0) return 1
  return Math.max(1, Math.floor((inner + gap) / (cardWidth + gap)))
}

/** Inverse of {@link columnsFor}: the card width that yields `columns`. */
export function widthForColumns(inner: number, gap: number, columns: number): number {
  const cols = Math.max(1, columns)
  return clampCardWidth((inner + gap) / cols - gap)
}

/**
 * One zoom step. `direction` is +1 to zoom in (bigger cards, fewer per row),
 * -1 to zoom out. Returns the new card width and the column count it actually
 * produces — at the clamp boundaries that isn't necessarily the target, so the
 * caller reports the real number rather than the wish.
 */
export function zoomStep(
  inner: number,
  gap: number,
  cardWidth: number,
  direction: 1 | -1
): { cardWidth: number; columns: number } {
  const columns = columnsFor(inner, gap, cardWidth)
  const target = Math.max(1, Math.min(MAX_COLUMNS, columns - direction))
  const next = widthForColumns(inner, gap, target)
  return { cardWidth: next, columns: columnsFor(inner, gap, next) }
}
