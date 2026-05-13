/**
 * Canonical Fab listing-type slugs. Categories with `id` matching one of
 * these aren't user-facing "Fab Categories" — they're the second-dropdown
 * listing-type filter and live in their own column.
 *
 * Kept in this file (not in `normalize.ts`) so the schema-migration code
 * can import it without pulling in the sync layer.
 */
export const FAB_LISTING_TYPE_IDS = new Set<string>([
  '3d-model',
  'animation',
  'audio',
  'game-system',
  'game-template',
  'material',
  'tool-and-plugin',
  'tutorials-examples',
  'ui',
  'vfx'
])

/**
 * Map Fab UE category path → canonical listing-type slug. UE-side `categories[]`
 * doesn't carry the canonical slug; it ships path-shaped ids like
 * `Assets/animations` or `Assets/blueprints` instead. Only a handful of asset
 * types ever land here (CODE_PLUGIN style assets get the proper `tool-and-plugin`
 * entry directly), so we map the path inventory by hand.
 *
 * Keys are stored lower-case; lookup must lower-case the input first.
 */
export const FAB_UE_PATH_TO_LISTING_TYPE: Record<string, string> = {
  'assets/2d': 'material',
  'assets/animations': 'animation',
  'assets/audio': 'audio',
  'assets/soundfx': 'audio',
  'assets/blueprints': 'game-system',
  'assets/characters': '3d-model',
  'assets/communitysamples': 'game-template',
  'assets/environments': '3d-model',
  'assets/fx': 'vfx',
  'assets/materials': 'material',
  'assets/textures': 'material',
  'assets/megascans': '3d-model',
  'assets/onlinelearning': 'tutorials-examples',
  'assets/props': '3d-model',
  'assets/showcasedemos': 'game-template',
  'assets/weapons': '3d-model'
}

/**
 * Final-fallback mapping from `FabLibraryItem.distributionMethod` to canonical
 * listing-type slug, for assets whose categories array doesn't yield anything.
 */
export const FAB_DISTRIBUTION_TO_LISTING_TYPE: Record<string, string> = {
  CODE_PLUGIN: 'tool-and-plugin',
  COMPLETE_PROJECT: 'game-template'
}

/**
 * Slugify a Fab category `name` into the kebab-case form used both as the
 * `asset_tags.tag` storage key and as the value the UI dropdown emits when
 * filtering.
 *
 * - `&` is dropped (Fab's convention: `Tutorials & Examples` → `tutorials-examples`)
 * - everything else non-alphanumeric collapses to a single `-`
 * - leading/trailing dashes are stripped
 *
 * Examples:
 *   "Abandoned"           → "abandoned"
 *   "Action-Adventure"    → "action-adventure"
 *   "Animation & Rigging" → "animation-rigging"
 *   "3D Model"            → "3d-model"
 */
export function slugifyCategory(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/&/g, ' ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}
