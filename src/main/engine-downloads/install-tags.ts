/**
 * Static taxonomy of the Epic Games Launcher engine-manifest `InstallTags`.
 *
 * Engine manifests group every file by one or more InstallTags. The launcher
 * lets users opt-in to subsets (target platforms, editor symbols, …) on top
 * of a mandatory Core. This module maps the raw tag names we see in real
 * manifests to display labels + default selection state + dependency rules,
 * and exposes a helper to merge the static taxonomy with the live histogram
 * a parsed manifest yields.
 *
 * Tags observed in the wild (2026-05-15, UE 5.8 manifest):
 *   ""                  → Core editor + content + plugins (forced)
 *   "editor_symbols"    → PDB debug symbols (large, opt-in)
 *   "templates"         → TP_* project templates
 *   "engine_source"     → C++ engine source code
 *   "metahuman_content" → default MetaHuman characters
 *   "platform_Android"  → Android cross-compile target
 *   "platform_IOS"      → iOS cross-compile target
 *   "platform_TVOS"     → tvOS (requires iOS)
 *   "platform_Linux"    → Linux cross-compile target
 *   "platform_WinARM64" → Windows ARM64 target
 *   "platform_VOS"      → visionOS target
 *
 * Older UE versions also surface "starter_content"; newer ones (5.8+) fold
 * it into Core. The dialog only renders tags actually present in the live
 * manifest, so this is automatically version-aware.
 */

export interface KnownComponentMeta {
  /** Display label shown in the components dialog. */
  label: string
  /** Default checkbox state when opening a fresh dialog. */
  defaultEnabled: boolean
  /** Render as a disabled, always-checked row (Core). */
  alwaysIncluded: boolean
  /** Group under the collapsible "Target Platforms" section. */
  isPlatform: boolean
  /** Other tags that must be enabled when this one is. */
  requires?: string[]
  /** Stable order within its group (lower first). */
  sortKey: number
}

/**
 * Manifest tags we recognise. Unknown tags fall back to a generated label
 * (`Other: <tag>`) and ship under "Other components" so future Epic
 * additions don't silently disappear from the UI.
 */
export const KNOWN_COMPONENTS: Record<string, KnownComponentMeta> = {
  '': {
    label: 'Core Components',
    defaultEnabled: true,
    alwaysIncluded: true,
    isPlatform: false,
    sortKey: 0
  },
  starter_content: {
    label: 'Starter Content',
    defaultEnabled: true,
    alwaysIncluded: false,
    isPlatform: false,
    sortKey: 10
  },
  templates: {
    label: 'Templates and Feature Packs',
    defaultEnabled: true,
    alwaysIncluded: false,
    isPlatform: false,
    sortKey: 20
  },
  engine_source: {
    label: 'Engine Source',
    defaultEnabled: true,
    alwaysIncluded: false,
    isPlatform: false,
    sortKey: 30
  },
  editor_symbols: {
    label: 'Editor symbols for debugging',
    defaultEnabled: false,
    alwaysIncluded: false,
    isPlatform: false,
    sortKey: 40
  },
  metahuman_content: {
    label: 'MetaHuman default content',
    defaultEnabled: false,
    alwaysIncluded: false,
    isPlatform: false,
    sortKey: 50
  },
  platform_Android: {
    label: 'Android',
    defaultEnabled: false,
    alwaysIncluded: false,
    isPlatform: true,
    sortKey: 100
  },
  platform_IOS: {
    label: 'iOS',
    defaultEnabled: false,
    alwaysIncluded: false,
    isPlatform: true,
    sortKey: 110
  },
  platform_TVOS: {
    label: 'tvOS (requires iOS)',
    defaultEnabled: false,
    alwaysIncluded: false,
    isPlatform: true,
    requires: ['platform_IOS'],
    sortKey: 120
  },
  platform_Linux: {
    label: 'Linux',
    defaultEnabled: false,
    alwaysIncluded: false,
    isPlatform: true,
    sortKey: 130
  },
  platform_WinARM64: {
    label: 'Windows ARM64',
    defaultEnabled: false,
    alwaysIncluded: false,
    isPlatform: true,
    sortKey: 140
  },
  platform_VOS: {
    label: 'visionOS',
    defaultEnabled: false,
    alwaysIncluded: false,
    isPlatform: true,
    sortKey: 150
  }
}

export interface ComponentDescriptor {
  tag: string
  label: string
  defaultEnabled: boolean
  alwaysIncluded: boolean
  isPlatform: boolean
  requires?: string[]
  /** Files tagged with this `tag`. */
  fileCount: number
  /** Sum of decompressed file sizes for files tagged with this `tag`. */
  bytes: number
}

/** Histogram entry shape produced by parsing a manifest. */
export interface TagHistogramEntry {
  tag: string
  fileCount: number
  bytes: number
}

/**
 * Cross the static taxonomy with the live histogram. Tags present in the
 * histogram but not in the taxonomy come through with a generated label
 * (so brand-new Epic tags surface to the user instead of vanishing). Tags
 * in the taxonomy that aren't in the histogram are dropped (older engine
 * versions don't have every tag).
 */
export function describeComponents(histogram: TagHistogramEntry[]): ComponentDescriptor[] {
  const descriptors: ComponentDescriptor[] = histogram.map((entry) => {
    const known = KNOWN_COMPONENTS[entry.tag]
    if (known) {
      return {
        tag: entry.tag,
        label: known.label,
        defaultEnabled: known.defaultEnabled,
        alwaysIncluded: known.alwaysIncluded,
        isPlatform: known.isPlatform,
        requires: known.requires,
        fileCount: entry.fileCount,
        bytes: entry.bytes
      }
    }
    // Unknown tag — surface it under a synthetic label so new Epic tags
    // remain visible rather than silently disappearing.
    return {
      tag: entry.tag,
      label: `Other: ${entry.tag}`,
      defaultEnabled: false,
      alwaysIncluded: false,
      isPlatform: entry.tag.toLowerCase().startsWith('platform_'),
      fileCount: entry.fileCount,
      bytes: entry.bytes
    }
  })
  descriptors.sort((a, b) => {
    const ka = KNOWN_COMPONENTS[a.tag]?.sortKey ?? 1000
    const kb = KNOWN_COMPONENTS[b.tag]?.sortKey ?? 1000
    if (ka !== kb) return ka - kb
    return a.label.localeCompare(b.label)
  })
  return descriptors
}

/**
 * Given a user's current selection and a freshly toggled tag, propagate
 * dependency rules so that toggling `tag` also flips its required deps.
 * Returns the new selection set.
 *
 * - Enabling tvOS auto-enables iOS.
 * - Disabling iOS auto-disables tvOS (everything that requires it).
 *
 * `alwaysIncluded` tags are kept in the selection regardless.
 */
export function applyDependencyRules(
  descriptors: ComponentDescriptor[],
  selectedTags: Set<string>
): Set<string> {
  const out = new Set(selectedTags)
  // Always-included tags are always selected.
  for (const d of descriptors) {
    if (d.alwaysIncluded) out.add(d.tag)
  }
  // Forward propagation: every selected tag pulls in its `requires`.
  let changed = true
  while (changed) {
    changed = false
    for (const d of descriptors) {
      if (!out.has(d.tag)) continue
      for (const req of d.requires ?? []) {
        if (!out.has(req)) {
          out.add(req)
          changed = true
        }
      }
    }
  }
  // Reverse propagation: when a tag is unselected, drop everything that
  // requires it.
  changed = true
  while (changed) {
    changed = false
    for (const d of descriptors) {
      if (out.has(d.tag)) continue
      for (const other of descriptors) {
        if ((other.requires ?? []).includes(d.tag) && out.has(other.tag)) {
          out.delete(other.tag)
          changed = true
        }
      }
    }
  }
  return out
}
