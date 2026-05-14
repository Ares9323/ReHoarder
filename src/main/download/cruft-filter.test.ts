import { describe, it, expect } from 'vitest'
import {
  compilePattern,
  compilePatterns,
  matchesAny,
  DEFAULT_CRUFT_PATTERNS,
  platformBinaryPatterns
} from './cruft-filter'

describe('compilePattern', () => {
  it('matches a literal extension at any depth with **/*.ext', () => {
    const re = compilePattern('**/*.pdf')
    expect(re.test('README.pdf')).toBe(true)
    expect(re.test('Documentation/Guide.pdf')).toBe(true)
    expect(re.test('a/b/c/file.pdf')).toBe(true)
    expect(re.test('file.pdf.bak')).toBe(false)
  })

  it('matches a top-level directory with `Foo/**`', () => {
    const re = compilePattern('Documentation/**')
    expect(re.test('Documentation')).toBe(true)
    expect(re.test('Documentation/x.txt')).toBe(true)
    expect(re.test('Documentation/sub/x.txt')).toBe(true)
    expect(re.test('Foo/Documentation/x.txt')).toBe(false)
  })

  it('treats `*` as in-segment only (no slashes)', () => {
    const re = compilePattern('Content/*.uasset')
    expect(re.test('Content/Mesh.uasset')).toBe(true)
    expect(re.test('Content/Sub/Mesh.uasset')).toBe(false)
  })

  it('treats `?` as one non-slash char', () => {
    const re = compilePattern('file?.txt')
    expect(re.test('file1.txt')).toBe(true)
    expect(re.test('file12.txt')).toBe(false)
    expect(re.test('file/.txt')).toBe(false)
  })

  it('escapes regex metacharacters in the literal part', () => {
    const re = compilePattern('[Demo](a+b).txt')
    expect(re.test('[Demo](a+b).txt')).toBe(true)
    expect(re.test('Demoab.txt')).toBe(false)
  })

  it('is case-insensitive', () => {
    const re = compilePattern('**/*.PDF')
    expect(re.test('foo.pdf')).toBe(true)
    expect(re.test('FOO.PDF')).toBe(true)
  })

  it('throws on empty string', () => {
    expect(() => compilePattern('')).toThrow()
  })
})

describe('matchesAny', () => {
  it('returns false for an empty pattern list', () => {
    expect(matchesAny('anything.txt', [])).toBe(false)
  })

  it('normalises backslashes to forward slashes', () => {
    const ps = compilePatterns(['**/*.pdf'])
    expect(matchesAny('Documentation\\Guide.pdf', ps)).toBe(true)
  })

  it('strips a leading slash before matching', () => {
    const ps = compilePatterns(['Documentation/**'])
    expect(matchesAny('/Documentation/file.txt', ps)).toBe(true)
  })

  it('returns true on the first hit and false when nothing matches', () => {
    const ps = compilePatterns(['**/*.pdf', 'Documentation/**'])
    expect(matchesAny('Content/Mesh.uasset', ps)).toBe(false)
    expect(matchesAny('Documentation/Guide.pdf', ps)).toBe(true)
  })
})

describe('DEFAULT_CRUFT_PATTERNS', () => {
  const ps = compilePatterns([...DEFAULT_CRUFT_PATTERNS])
  it('catches typical vendor bloat', () => {
    expect(matchesAny('Documentation/Guide.pdf', ps)).toBe(true)
    expect(matchesAny('Source/MyPack/Textures/RawSource.psd', ps)).toBe(true)
    expect(matchesAny('Meshes/Source/Char.blend', ps)).toBe(true)
    expect(matchesAny('README.txt', ps)).toBe(true)
    expect(matchesAny('LICENSE', ps)).toBe(true)
  })
  it('does NOT match runtime-required uassets and textures', () => {
    expect(matchesAny('Content/Meshes/Char.uasset', ps)).toBe(false)
    expect(matchesAny('Content/Textures/Albedo.uasset', ps)).toBe(false)
    expect(matchesAny('Content/Materials/MI_Foo.uasset', ps)).toBe(false)
  })
})

describe('platformBinaryPatterns', () => {
  it('excludes only the current platform on win32', () => {
    const ps = compilePatterns(platformBinaryPatterns('win32'))
    expect(matchesAny('MyPlugin/Binaries/Mac/Foo.dylib', ps)).toBe(true)
    expect(matchesAny('MyPlugin/Binaries/Linux/Foo.so', ps)).toBe(true)
    expect(matchesAny('MyPlugin/Intermediate/Build/Android/Inc/x.h', ps)).toBe(true)
    expect(matchesAny('MyPlugin/Binaries/Win64/Foo.dll', ps)).toBe(false)
    expect(matchesAny('MyPlugin/Binaries/Win32/Foo.dll', ps)).toBe(false)
  })

  it('keeps both Linux and LinuxArm64 on linux hosts', () => {
    const ps = compilePatterns(platformBinaryPatterns('linux'))
    expect(matchesAny('Plugin/Binaries/Linux/foo.so', ps)).toBe(false)
    expect(matchesAny('Plugin/Binaries/LinuxArm64/foo.so', ps)).toBe(false)
    expect(matchesAny('Plugin/Binaries/Win64/foo.dll', ps)).toBe(true)
    expect(matchesAny('Plugin/Binaries/Mac/foo.dylib', ps)).toBe(true)
  })

  it('returns an empty list for unrecognised platforms', () => {
    expect(platformBinaryPatterns('aix' as NodeJS.Platform)).toEqual(
      // every platform token is "off", so we get 2 entries per token
      expect.arrayContaining(['**/Binaries/Win64/**'])
    )
  })
})
