/**
 * Destination model for "Add to project" relocation, shared by the main
 * process (validation, planning) and the renderer (inline validation, live
 * preview). Pure: no fs, no Electron.
 */

/** `'game'` mounts at `/Game` (= `<project>/Content`); a plugin mounts at `/<Name>`. */
export type DestinationMount = 'game' | { plugin: string }

export interface AddToProjectDestination {
  mount: DestinationMount
  /** Optional `/`-separated path under the mount, e.g. `ThirdParty/Env`. */
  subfolder?: string
  /** Optional new name for the pack's single top-level folder. */
  rename?: string
}

const SEGMENT_RE = /^[A-Za-z0-9_-]+$/

/** `null` when valid, otherwise a user-facing error. */
export function validateSegment(s: string): string | null {
  if (s.length === 0) return 'Name is empty'
  if (!SEGMENT_RE.test(s)) {
    return `"${s}" may only contain letters, digits, "_" and "-"`
  }
  return null
}

/** `null` when valid (an empty string means "no subfolder"), otherwise a user-facing error. */
export function validateSegmentPath(s: string): string | null {
  if (s.length === 0) return null
  if (s.startsWith('/') || s.endsWith('/')) return 'Subfolder cannot start or end with "/"'
  for (const seg of s.split('/')) {
    if (seg.length === 0) return 'Subfolder contains an empty segment ("//")'
    const err = validateSegment(seg)
    if (err) return err
  }
  return null
}

export function mountRoot(mount: DestinationMount): string {
  return mount === 'game' ? '/Game' : `/${mount.plugin}`
}

function norm(s: string | undefined): string {
  return (s ?? '').trim()
}

/**
 * True when the destination is the plain `<project>/Content` merge the fast
 * copy path already handles: Content mount, no subfolder, and no rename (or a
 * rename identical to the pack's only top folder).
 */
export function isDefaultDestination(
  dest: AddToProjectDestination | undefined | null,
  topFolders: string[]
): boolean {
  if (!dest) return true
  if (dest.mount !== 'game') return false
  if (norm(dest.subfolder) !== '') return false
  const rename = norm(dest.rename)
  if (rename === '') return true
  return topFolders.length === 1 && topFolders[0] === rename
}

/**
 * Name and shape rules for a destination, given the pack's top-level folders
 * and loose root packages. `null` when valid, otherwise a user-facing error.
 * Plugin existence is checked by the caller (it needs the project's plugins).
 */
export function validateDestination(
  dest: AddToProjectDestination,
  topFolders: string[],
  looseAssets: string[]
): string | null {
  const subfolder = norm(dest.subfolder)
  const rename = norm(dest.rename)
  const subErr = validateSegmentPath(subfolder)
  if (subErr) return `Subfolder: ${subErr}`
  if (rename !== '') {
    if (topFolders.length !== 1 || looseAssets.length > 0) {
      return 'Rename is only possible when the pack has exactly one top-level folder'
    }
    const renameErr = validateSegment(rename)
    if (renameErr) return `Rename: ${renameErr}`
    if (
      dest.mount === 'game' &&
      subfolder === '' &&
      rename !== topFolders[0] &&
      rename.toLowerCase() === topFolders[0].toLowerCase()
    ) {
      return 'A rename that only changes letter case is not supported'
    }
  }
  if (dest.mount === 'game' && subfolder !== '') {
    // Moving /Game/T into /Game/T/... would nest a folder inside itself.
    const first = subfolder.split('/')[0].toLowerCase()
    const clash = topFolders.find((t) => t.toLowerCase() === first)
    if (clash) return `Subfolder cannot start with "${clash}", a folder of the pack itself`
  }
  return null
}

/** Unreal package paths each top folder will end up at. */
export function previewDestinations(
  dest: AddToProjectDestination,
  topFolders: string[]
): string[] {
  const base = [mountRoot(dest.mount), norm(dest.subfolder)].filter((s) => s !== '').join('/')
  const rename = norm(dest.rename)
  return topFolders.map(
    (t) => `${base}/${topFolders.length === 1 && rename !== '' ? rename : t}`
  )
}
