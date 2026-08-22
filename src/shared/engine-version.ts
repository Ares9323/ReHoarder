/**
 * Parsed Unreal engine version reduced to `major.minor`. Patch and any
 * trailing components are dropped — installed-engine `EngineAssociation`
 * values are `major.minor` (e.g. `5.7`, `4.27`), so that's the resolution
 * we compare at.
 */
export interface ParsedEngineVersion {
  major: number
  minor: number
}

/**
 * Parse a version string into `{ major, minor }`, or `null` when it isn't a
 * numeric `major[.minor]` (source-build GUIDs, empty strings, garbage). A
 * bare major (`"5"`) resolves to minor `0`.
 */
export function parseEngineVersion(
  s: string | null | undefined
): ParsedEngineVersion | null {
  if (!s) return null
  const m = /^\s*(\d+)(?:\.(\d+))?/.exec(s)
  if (!m) return null
  const major = Number(m[1])
  const minor = m[2] === undefined ? 0 : Number(m[2])
  if (!Number.isFinite(major) || !Number.isFinite(minor)) return null
  return { major, minor }
}

/**
 * True when `target` (a project's engine) is the same as or newer than
 * `required` (the version an asset/project was downloaded for). UE is
 * forward-compatible (newer editor opens older assets) but not backward-
 * compatible, so "target >= required" is the correct guard. An unparsable
 * `required` or `target` is treated as incompatible.
 */
export function isEngineCompatible(
  required: string | null | undefined,
  target: string | null | undefined
): boolean {
  const req = parseEngineVersion(required)
  const tgt = parseEngineVersion(target)
  if (!req || !tgt) return false
  if (tgt.major !== req.major) return tgt.major > req.major
  return tgt.minor >= req.minor
}
