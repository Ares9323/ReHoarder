import { describe, it, expect } from 'vitest'
import {
  validateSegment,
  validateSegmentPath,
  isDefaultDestination,
  previewDestinations,
  validateDestination
} from './relocate-destination'

describe('validateSegment', () => {
  it('accepts letters, digits, underscore and dash', () => {
    expect(validateSegment('Rocks_01-b')).toBeNull()
  })
  it('rejects empty, spaces, dots and slashes', () => {
    expect(validateSegment('')).toMatch(/empty/i)
    expect(validateSegment('My Rocks')).not.toBeNull()
    expect(validateSegment('..')).not.toBeNull()
    expect(validateSegment('a/b')).not.toBeNull()
    expect(validateSegment('a.b')).not.toBeNull()
  })
})

describe('validateSegmentPath', () => {
  it('accepts an empty path (no subfolder) and nested segments', () => {
    expect(validateSegmentPath('')).toBeNull()
    expect(validateSegmentPath('ThirdParty/Env_Packs')).toBeNull()
  })
  it('rejects leading, trailing and double slashes, backslashes and ..', () => {
    expect(validateSegmentPath('/ThirdParty')).not.toBeNull()
    expect(validateSegmentPath('ThirdParty/')).not.toBeNull()
    expect(validateSegmentPath('A//B')).not.toBeNull()
    expect(validateSegmentPath('A\\B')).not.toBeNull()
    expect(validateSegmentPath('A/../B')).not.toBeNull()
    expect(validateSegmentPath('A/B C')).not.toBeNull()
  })
})

describe('isDefaultDestination', () => {
  it('is default when omitted or Content with no subfolder and no rename', () => {
    expect(isDefaultDestination(undefined, ['Rocks'])).toBe(true)
    expect(isDefaultDestination({ mount: 'game' }, ['Rocks'])).toBe(true)
    expect(isDefaultDestination({ mount: 'game', subfolder: '', rename: '' }, ['Rocks'])).toBe(
      true
    )
  })
  it('treats a rename equal to the only top folder as default', () => {
    expect(isDefaultDestination({ mount: 'game', rename: 'Rocks' }, ['Rocks'])).toBe(true)
  })
  it('is not default with a subfolder, a plugin mount or a real rename', () => {
    expect(isDefaultDestination({ mount: 'game', subfolder: 'ThirdParty' }, ['Rocks'])).toBe(false)
    expect(isDefaultDestination({ mount: { plugin: 'MyPlug' } }, ['Rocks'])).toBe(false)
    expect(isDefaultDestination({ mount: 'game', rename: 'Stones' }, ['Rocks'])).toBe(false)
  })
})

describe('validateDestination', () => {
  it('accepts valid subfolder and rename combinations', () => {
    expect(validateDestination({ mount: 'game', subfolder: 'ThirdParty' }, ['Rocks'], [])).toBeNull()
    expect(validateDestination({ mount: 'game', rename: 'Stones' }, ['Rocks'], [])).toBeNull()
    expect(validateDestination({ mount: { plugin: 'Art' }, rename: 'Rocks' }, ['Rocks'], [])).toBeNull()
  })
  it('flags bad names, case-only renames and self-nesting subfolders', () => {
    expect(validateDestination({ mount: 'game', subfolder: 'a b' }, ['Rocks'], [])).toMatch(/Subfolder/)
    expect(validateDestination({ mount: 'game', rename: 'x.y' }, ['Rocks'], [])).toMatch(/Rename/)
    expect(validateDestination({ mount: 'game', rename: 'rocks' }, ['Rocks'], [])).toMatch(/case/)
    expect(validateDestination({ mount: 'game', subfolder: 'rocks/x' }, ['Rocks'], [])).toMatch(
      /Rocks/
    )
  })
  it('refuses a rename unless there is exactly one top folder and no loose assets', () => {
    expect(validateDestination({ mount: 'game', rename: 'X' }, ['A', 'B'], [])).toMatch(/one/)
    expect(validateDestination({ mount: 'game', rename: 'X' }, ['A'], ['L'])).toMatch(/one/)
  })
})

describe('previewDestinations', () => {
  it('maps every top folder under the mount and subfolder', () => {
    expect(
      previewDestinations({ mount: 'game', subfolder: 'ThirdParty' }, ['A', 'B'])
    ).toEqual(['/Game/ThirdParty/A', '/Game/ThirdParty/B'])
  })
  it('applies the rename to a single top folder and uses the plugin mount', () => {
    expect(
      previewDestinations({ mount: { plugin: 'MyPlug' }, rename: 'Stones' }, ['Rocks'])
    ).toEqual(['/MyPlug/Stones'])
  })
})
