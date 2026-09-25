import { describe, it, expect } from 'vitest'
import { enterSubmitsDialog } from './dialog-keys'

describe('enterSubmitsDialog', () => {
  it('ignores Enter pressed inside form controls', () => {
    // A native <select> commits the highlighted option on Enter: submitting on
    // that keydown would use the previous value.
    for (const tagName of ['SELECT', 'INPUT', 'TEXTAREA', 'BUTTON', 'OPTION']) {
      expect(enterSubmitsDialog({ tagName }), tagName).toBe(false)
    }
  })

  it('submits when focus is on the dialog itself or nothing', () => {
    expect(enterSubmitsDialog({ tagName: 'DIV' })).toBe(true)
    expect(enterSubmitsDialog({ tagName: 'BODY' })).toBe(true)
    expect(enterSubmitsDialog(null)).toBe(true)
  })

  it('ignores contenteditable targets', () => {
    expect(enterSubmitsDialog({ tagName: 'DIV', isContentEditable: true })).toBe(false)
  })
})
