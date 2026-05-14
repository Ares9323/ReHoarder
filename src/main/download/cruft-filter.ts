/**
 * Translate the user-facing glob patterns ReHoarder uses to describe "asset
 * cruft" (docs, sample projects, source assets, off-platform binaries, …)
 * into compiled regexes, and offer a single `matchesAny` predicate over a
 * file's relative path inside an asset's data dir.
 *
 * Pattern syntax (intentionally small — no escaping bracket classes etc.):
 *   `?`   one character (not `/`)
 *   `*`   zero or more characters (not `/`)
 *   `**`  zero or more path segments, including `/`
 *
 * Matching is case-insensitive (Windows-friendly) and slash-tolerant: paths
 * are normalised to forward slashes before matching, so authors of the
 * pattern list don't need to worry about `\\` showing up at runtime.
 */

/**
 * Translate one glob string into an anchored case-insensitive RegExp. Throws
 * if the input is not a non-empty string so a typo in user settings surfaces
 * loudly instead of silently matching nothing.
 */
export function compilePattern(glob: string): RegExp {
  if (typeof glob !== 'string' || glob.length === 0) {
    throw new Error('compilePattern: glob must be a non-empty string')
  }
  let out = ''
  let i = 0
  while (i < glob.length) {
    const c = glob[i]
    // `/**` (slash + double star) — matches zero or more path segments,
    // including the case where the path stops exactly at the parent (so
    // `Documentation/**` matches `Documentation` itself).
    if (c === '/' && glob[i + 1] === '*' && glob[i + 2] === '*') {
      out += '(?:/.*)?'
      i += 3
      if (glob[i] === '/') i++ // tolerate `/**/` syntax mid-pattern
      continue
    }
    // `**/` (double star + slash) at the start or after a separator — zero or
    // more path segments followed by a trailing separator.
    if (c === '*' && glob[i + 1] === '*' && glob[i + 2] === '/') {
      out += '(?:.*/)?'
      i += 3
      continue
    }
    // Bare `**` — anywhere, just "anything including slashes".
    if (c === '*' && glob[i + 1] === '*') {
      out += '.*'
      i += 2
      continue
    }
    if (c === '*') {
      out += '[^/]*'
      i++
      continue
    }
    if (c === '?') {
      out += '[^/]'
      i++
      continue
    }
    if (/[.+^$(){}|[\]\\]/.test(c)) {
      out += '\\' + c
      i++
      continue
    }
    // Literal character (incl. `/`).
    out += c
    i++
  }
  return new RegExp(`^${out}$`, 'i')
}

/** Compile a list of globs, dropping empty entries silently. */
export function compilePatterns(globs: string[]): RegExp[] {
  return globs.filter((g) => typeof g === 'string' && g.length > 0).map(compilePattern)
}

/**
 * Normalise a manifest-supplied path to forward slashes and trim any leading
 * separator so glob patterns can be written without one. Empty paths and
 * paths that resolve to just `.` are returned unchanged.
 */
function normaliseRel(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\/+/, '')
}

/** True iff `relPath` matches any of the pre-compiled patterns. */
export function matchesAny(relPath: string, patterns: RegExp[]): boolean {
  if (patterns.length === 0) return false
  const norm = normaliseRel(relPath)
  for (const re of patterns) {
    if (re.test(norm)) return true
  }
  return false
}

/**
 * Default cruft patterns shipped with ReHoarder. Errs on the conservative
 * side: only formats that are *never* runtime-required for an Unreal asset
 * (PDFs, doc folders, DCC source files) are listed by default. Users can
 * extend this in Settings → Downloads → Cruft patterns.
 */
export const DEFAULT_CRUFT_PATTERNS: readonly string[] = Object.freeze([
  'Documentation/**',
  '**/Documentation/**',
  '**/*.pdf',
  '**/*.psd',
  '**/*.max',
  '**/*.blend',
  '**/*.blend1',
  '**/*.ma',
  '**/*.mb',
  '**/*.zpr',
  '**/*.zbrush',
  '**/*.ztl',
  '**/README*',
  '**/READ_ME*',
  '**/READ ME*',
  '**/CREDITS*',
  '**/LICENSE*'
])

/**
 * Glob patterns that select Unreal's `Binaries/<plat>/` and `Intermediate/Build/<plat>/`
 * subtrees for every platform OTHER than `currentPlatform`. Used when the
 * `deleteExtraVaultPlatforms` setting is on.
 *
 * Recognised platform tokens are taken from the Unreal Engine 5 binary
 * conventions: Win64, Linux, LinuxArm64, Mac (alongside its Universal/
 * x86_64/arm64 variants), IOS, TVOS, VisionOS, Android, HoloLens.
 */
const ALL_PLATFORM_TOKENS = [
  'Win64',
  'Win32',
  'Linux',
  'LinuxArm64',
  'Mac',
  'IOS',
  'TVOS',
  'VisionOS',
  'Android',
  'HoloLens'
] as const

function nodePlatformToUeTokens(nodePlatform: NodeJS.Platform): readonly string[] {
  if (nodePlatform === 'win32') return ['Win64', 'Win32']
  if (nodePlatform === 'darwin') return ['Mac']
  if (nodePlatform === 'linux') return ['Linux', 'LinuxArm64']
  return []
}

export function platformBinaryPatterns(
  nodePlatform: NodeJS.Platform = process.platform
): string[] {
  const keep = new Set(nodePlatformToUeTokens(nodePlatform))
  const offTargets = ALL_PLATFORM_TOKENS.filter((p) => !keep.has(p))
  const out: string[] = []
  for (const tok of offTargets) {
    out.push(`**/Binaries/${tok}/**`)
    out.push(`**/Intermediate/Build/${tok}/**`)
  }
  return out
}

export interface SkipPatternComposition {
  /** When true, append the built-in cruft list + `userExtras`. */
  includeCruft: boolean
  /** User-supplied extras, applied only when `includeCruft` is true. */
  userExtras: string[]
  /** When true, append `platformBinaryPatterns()` for the current host. */
  includePlatformBinaries: boolean
}

/**
 * Compose the effective skip-pattern list used at both download time and
 * vault-cleanup time. Centralises the precedence rules so the two call
 * sites can't drift apart.
 */
export function composeSkipPatterns(input: SkipPatternComposition): string[] {
  const out: string[] = []
  if (input.includeCruft) {
    out.push(...DEFAULT_CRUFT_PATTERNS)
    out.push(...input.userExtras)
  }
  if (input.includePlatformBinaries) {
    out.push(...platformBinaryPatterns())
  }
  return out
}
