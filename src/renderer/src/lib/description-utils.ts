/**
 * Convert an HTML-ish description into a single line of plain text suitable
 * for an asset card. Fab payloads frequently ship literal HTML in the
 * description / technicalDetails fields (`<ul><li><p>…</p></li></ul>`), and
 * those tags would otherwise show through to the user.
 *
 * Structural tags become whitespace before extraction so words on separate
 * `<li>` elements don't get glued together. Inline tags (`<b>`, `<em>`, …)
 * are stripped by `textContent`. HTML entities (`&amp;` etc.) are decoded by
 * `DOMParser`. Whitespace is collapsed and trimmed at the end.
 */
export function stripHtmlToText(s: string | null | undefined): string | null {
  if (s === null || s === undefined) return null
  // Structural tags → single space; this keeps "A</li><li>B" from becoming "AB".
  const prepped = s.replace(/<\/?(li|p|br|div|h[1-6]|tr|td)(\s[^>]*)?>/gi, ' ')
  const doc = new DOMParser().parseFromString(prepped, 'text/html')
  return (doc.body.textContent ?? '').replace(/\s+/g, ' ').trim()
}
