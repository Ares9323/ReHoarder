const FORM_CONTROLS = new Set(['SELECT', 'OPTION', 'INPUT', 'TEXTAREA', 'BUTTON'])

/**
 * Whether a window-level Enter should submit a modal. Enter inside a form
 * control belongs to that control: a native <select> commits the highlighted
 * option on Enter, and a dialog listening on `window` would otherwise submit
 * with the value from before that commit.
 */
export function enterSubmitsDialog(
  target: { tagName?: string; isContentEditable?: boolean } | null
): boolean {
  if (!target) return true
  if (target.isContentEditable) return false
  return !FORM_CONTROLS.has((target.tagName ?? '').toUpperCase())
}
