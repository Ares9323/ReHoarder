<script lang="ts">
  import { onMount } from 'svelte'
  import AssetCard from './AssetCard.svelte'
  import SyncLogPanel from './SyncLogPanel.svelte'
  import CustomInstallMenu from './CustomInstallMenu.svelte'
  import { settingsVersion } from '../stores/settings-events.svelte'
  import { enginesStore } from '../stores/engines.svelte'
  import { projectsStore } from '../stores/projects.svelte'
  import { downloadsStore } from '../stores/downloads.svelte'
  import { vaultStore } from '../stores/vault.svelte'
  import { clampCardWidth, zoomStep } from './grid-zoom'

  type AssetSource = 'vault' | 'fab' | 'legacy'
  type AssetSubSource = 'fab-ue' | 'fab-other' | null
  type SourceFilter =
    | 'all'
    | 'fab-ue'
    | 'fab-other'
    | 'bookmarks'
    | 'hidden'
    | 'downloaded'
    | 'updatable'

  interface AssetRow {
    source: AssetSource
    sourceId: string
    subSource: AssetSubSource
    listingType: string | null
    title: string
    description: string | null
    imageUrl: string | null
    productUrl: string | null
    ownedAt: number | null
    hidden: boolean
    bookmarked: boolean
    seller: string | null
    raw: string | null
    syncedAt: number
  }

  interface Props {
    assets: AssetRow[]
    countsBySource: Record<string, number>
    lastSync: Record<string, { at: number; status: string; error: string | null }>
    search: string
    sourceFilter: SourceFilter
    listingTypeFilter: string
    availableListingTypes: string[]
    categoryFilter: string
    availableCategories: string[]
    syncBusy: boolean
    progressText: string | null
    syncError: string | null
    syncLog: string[]
    onSearch: (s: string) => void
    onSourceFilter: (f: SourceFilter) => void
    onListingTypeFilter: (t: string) => void
    onCategoryFilter: (c: string) => void
    onSyncNow: () => void
    onToggleHidden: (asset: AssetRow) => void
    onToggleBookmark: (asset: AssetRow) => void
    /** Fired when the user picks "Refresh from Fab" on a Fab asset card.
     *  Parent triggers the IPC + refresh-from-DB; returns the IPC result
     *  so the card can surface failure text inline. */
    onRefreshFromFab: (asset: AssetRow) => Promise<{
      ok: boolean
      imageUrl?: string | null
      error?: string
    }>
  }

  let {
    assets,
    countsBySource,
    lastSync,
    search,
    sourceFilter,
    listingTypeFilter,
    availableListingTypes,
    categoryFilter,
    availableCategories,
    syncBusy,
    progressText,
    syncError,
    syncLog,
    onSearch,
    onSourceFilter,
    onListingTypeFilter,
    onCategoryFilter,
    onSyncNow,
    onToggleHidden,
    onToggleBookmark,
    onRefreshFromFab
  }: Props = $props()

  // Short engine version slugs (`5.4`, `4.27`) for engines the user has installed.
  // Used by AssetCard to decide whether a version chip click goes through the
  // "fast path" (auto-route + enqueue) or opens the Custom Install menu.
  // Distinct major.minor slugs ("5.4", "4.27") computed off the engines store.
  const installedEngineVersions = $derived(
    [
      ...new Set(
        installedEngines.map((e) => e.version.split('.').slice(0, 2).join('.'))
      )
    ].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
  )
  // Pull engines & projects from the shared singleton stores — same data the
  // Engines/Projects tabs render. No more parallel `engines.list()` + `projects.list()`
  // on every Assets-tab mount; the stores fetch once and cache.
  const installedEngines = $derived(
    enginesStore.engines.map((e) => ({
      name: e.name,
      path: e.path,
      version: e.version,
      majorVersion: e.majorVersion,
      editorExePath: e.editorExePath,
      hasEditor: e.hasEditor
    }))
  )
  const knownProjects = $derived(
    projectsStore.projects.map((p) => ({
      name: p.name,
      uprojectPath: p.uprojectPath,
      projectDir: p.projectDir,
      engineAssociation: p.engineAssociation
    }))
  )
  const projectPaths = $derived(projectsStore.scannedPaths)

  // Settings → Image size drives the asset grid density. Lazy-loaded once on
  // mount, refreshed when Settings save fires.
  type ImageSize = 'small' | 'medium' | 'large'
  let imageSize = $state<ImageSize>('small')

  // ---------------------------------------------------------------------
  // Grid zoom (Ctrl+wheel, Ctrl+± , Ctrl+0)
  //
  // Settings' Image size picks the *base* card width; zooming stores an exact
  // pixel width that overrides it until the user changes the Settings preset
  // again (or hits Ctrl+0). The grid keeps using `auto-fill` + `minmax`, so a
  // zoomed layout still reflows when the window is resized — we're changing
  // the minimum card width, not pinning a column count.
  // ---------------------------------------------------------------------
  const BASE_CARD_WIDTH: Record<ImageSize, number> = { small: 200, medium: 280, large: 380 }
  const CARD_WIDTH_KEY = 'rehoarder.assets.cardWidth'

  function loadCardWidth(): number | null {
    try {
      const raw = window.localStorage.getItem(CARD_WIDTH_KEY)
      if (!raw) return null
      const n = Number(raw)
      if (!Number.isFinite(n)) return null
      return clampCardWidth(n)
    } catch {
      return null
    }
  }

  /** `null` = follow the Settings preset. */
  let cardWidthOverride = $state<number | null>(loadCardWidth())
  const cardWidth = $derived(cardWidthOverride ?? BASE_CARD_WIDTH[imageSize])

  /** Bound to the grid element so zoom can measure the real content box. */
  let gridEl = $state<globalThis.HTMLDivElement | null>(null)

  /** Ephemeral "5 per row" readout shown for a moment after each zoom step. */
  let zoomHint = $state<string | null>(null)
  let zoomHintTimer: ReturnType<typeof window.setTimeout> | null = null
  function flashZoomHint(text: string): void {
    zoomHint = text
    if (zoomHintTimer) window.clearTimeout(zoomHintTimer)
    zoomHintTimer = window.setTimeout(() => {
      zoomHint = null
      zoomHintTimer = null
    }, 1400)
  }

  function persistCardWidth(n: number | null): void {
    try {
      if (n === null) window.localStorage.removeItem(CARD_WIDTH_KEY)
      else window.localStorage.setItem(CARD_WIDTH_KEY, String(n))
    } catch {
      // storage full / disabled — zoom just won't survive the session
    }
  }

  /**
   * One zoom step = exactly one column more or less, which is what the user
   * actually perceives. We measure the grid's real content box (padding and
   * gap read off the computed style rather than assumed) and hand it to
   * `zoomStep`, which does the column math.
   *
   * `direction` is +1 to zoom in (bigger cards, fewer per row), -1 to zoom out.
   */
  function zoomBy(direction: 1 | -1): void {
    const el = gridEl
    if (!el) {
      // No measurement available (shouldn't happen once mounted) — fall back
      // to a fixed step so the shortcut still does something sensible.
      const next = clampCardWidth(cardWidth + direction * 40)
      if (next === cardWidth) return
      cardWidthOverride = next
      persistCardWidth(next)
      return
    }
    const cs = window.getComputedStyle(el)
    const inner =
      el.clientWidth - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0)
    if (inner <= 0) return
    const gap = parseFloat(cs.columnGap) || 0
    const step = zoomStep(inner, gap, cardWidth, direction)
    if (step.cardWidth === cardWidth) return
    cardWidthOverride = step.cardWidth
    persistCardWidth(step.cardWidth)
    flashZoomHint(`${step.columns} per row`)
  }

  function resetZoom(): void {
    if (cardWidthOverride === null) return
    cardWidthOverride = null
    persistCardWidth(null)
    flashZoomHint('Default size')
  }

  /**
   * Ctrl+wheel. The listener is non-passive so `preventDefault` can suppress
   * Chromium's own page zoom. Throttled because a trackpad pinch fires a burst
   * of `ctrlKey` wheel events and would otherwise collapse the grid to one
   * column in a single gesture.
   */
  let lastZoomAt = 0
  $effect(() => {
    const onWheel = (e: globalThis.WheelEvent): void => {
      if (!e.ctrlKey && !e.metaKey) return
      e.preventDefault()
      // Don't zoom the grid underneath an open Custom Install menu.
      if (customMenuAsset) return
      if (e.deltaY === 0) return
      const now = Date.now()
      if (now - lastZoomAt < 80) return
      lastZoomAt = now
      zoomBy(e.deltaY < 0 ? 1 : -1)
    }
    window.addEventListener('wheel', onWheel, { passive: false })
    return () => window.removeEventListener('wheel', onWheel)
  })

  /** Keyboard equivalents for people without a wheel. */
  $effect(() => {
    const onKey = (e: globalThis.KeyboardEvent): void => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return
      if (customMenuAsset) return
      // `+` arrives as '+' (numpad / shifted) or '=' (unshifted US layout).
      if (e.key === '+' || e.key === '=') {
        e.preventDefault()
        zoomBy(1)
      } else if (e.key === '-' || e.key === '_') {
        e.preventDefault()
        zoomBy(-1)
      } else if (e.key === '0') {
        e.preventDefault()
        resetZoom()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  /**
   * Changing Image size in Settings is an explicit "I want this density"
   * statement, so it clears any zoom override. The very first load is exempt:
   * it's just us learning the stored preset, not the user changing it.
   */
  let assetSettingsLoaded = false
  async function loadAssetSettings(): Promise<void> {
    try {
      const s = await window.api.settings.get()
      const changed = assetSettingsLoaded && s.imageSize !== imageSize
      imageSize = s.imageSize
      assetSettingsLoaded = true
      if (changed && cardWidthOverride !== null) {
        cardWidthOverride = null
        persistCardWidth(null)
      }
    } catch {
      // best-effort: stay on the default
    }
  }

  onMount(() => {
    void enginesStore.ensureLoaded()
    void projectsStore.ensureLoaded()
    void loadAssetSettings()
  })

  let firstAssetSettingsTick = true
  $effect(() => {
    settingsVersion()
    if (firstAssetSettingsTick) {
      firstAssetSettingsTick = false
      return
    }
    void loadAssetSettings()
  })

  // The "Only Downloaded" Source filter cross-references vault folder names
  // with `assets.raw.{projectVersions[].artifactId, uid}` to surface legacy
  // downloads (AMS, Launcher) that predate the ReHoarder downloads table.
  // We trigger the vault scan lazily — only when the user actually picks that
  // filter — so people who never use it pay no boot cost.
  $effect(() => {
    if (sourceFilter === 'downloaded') {
      void vaultStore.ensureLoaded()
    }
  })

  // Settings save → re-scan both stores (paths / scan rules may have changed)
  // but skip the initial reactive tick to avoid double-loading on mount.
  let firstSettingsTick = true
  $effect(() => {
    settingsVersion()
    if (firstSettingsTick) {
      firstSettingsTick = false
      return
    }
    void enginesStore.rescan()
    void projectsStore.rescan()
  })

  /**
   * Whether the source badge is worth showing on the cards. `countsBySource` is
   * keyed by the DB `source` column (`vault` / `fab` / `legacy`), so a library
   * that only ever synced Fab has a single key — every badge would read "FAB"
   * and just eat pixels. With Vault / Legacy assets in the mix the label is the
   * only per-card signal of where an asset comes from, so it stays.
   *
   * Computed off the whole-library counts rather than the filtered `assets`
   * array so the badge doesn't blink in and out as the user changes filters.
   */
  const mixedSources = $derived(
    Object.entries(countsBySource).some(([src, n]) => src !== 'fab' && n > 0)
  )

  /** A Fab UE asset is treated as a plugin when `distributionMethod === 'CODE_PLUGIN'`. */
  function isPlugin(asset: AssetRow): boolean {
    return assetKindFor(asset) === 'plugin'
  }

  /**
   * Bucket the asset into the four kinds the UI cares about. Drives both the
   * tooltip wording ("Install" vs "Add to project" vs "Create project") and
   * the auto-route logic for downloads (only plugins land in `Engine/Plugins/`).
   *
   * Mapping is taken from Fab's `distributionMethod` field:
   *   - CODE_PLUGIN     → plugin
   *   - COMPLETE_PROJECT → project (full UE project; "Create project" workflow)
   *   - ASSET_PACK      → pack    ("Add to project" workflow)
   *   - everything else → other   (still downloadable, but no install action)
   */
  type AssetKind = 'plugin' | 'project' | 'pack' | 'other'
  function assetKindFor(asset: AssetRow): AssetKind {
    if (asset.source !== 'fab' || !asset.raw) return 'other'
    let dm: string | undefined
    try {
      dm = (JSON.parse(asset.raw) as { distributionMethod?: string }).distributionMethod
    } catch {
      return 'other'
    }
    if (dm === 'CODE_PLUGIN') return 'plugin'
    if (dm === 'COMPLETE_PROJECT') return 'project'
    if (dm === 'ASSET_PACK') return 'pack'
    return 'other'
  }

  /**
   * Can ReHoarder actually download this asset?
   *
   * `runFabAssetDownload` needs `raw.assetNamespace` plus a
   * `projectVersions[].artifactId` to ask Fab for a manifest. Those fields only
   * exist on the UE library payload (`/e/accounts/{id}/ue/library`). Listings
   * that came from the Other library (`/i/library/search`) — UEFN, Blender,
   * Maya, FBX, … — carry a completely different shape, so the download throws
   * "raw JSON is missing assetNamespace" the moment it starts. Rather than
   * offering a button that always fails, those cards get a "Get on Fab" link.
   */
  function isDownloadable(asset: AssetRow): boolean {
    if (asset.source !== 'fab' || !asset.raw) return false
    let parsed: {
      assetNamespace?: unknown
      projectVersions?: Array<{ artifactId?: unknown }>
    }
    try {
      parsed = JSON.parse(asset.raw)
    } catch {
      return false
    }
    if (typeof parsed.assetNamespace !== 'string' || parsed.assetNamespace.length === 0) {
      return false
    }
    return (parsed.projectVersions ?? []).some(
      (pv) => typeof pv.artifactId === 'string' && pv.artifactId.length > 0
    )
  }

  /**
   * Display names of the asset formats a Fab Other listing ships in
   * (`assetFormats[].assetFormatType.name`, e.g. "UEFN", "Blender"). Used to
   * tell the user *why* a listing can't be downloaded here.
   */
  function fabFormatsFor(asset: AssetRow): string[] {
    if (!asset.raw) return []
    let parsed: {
      assetFormats?: Array<{ assetFormatType?: { name?: unknown; code?: unknown } }>
    }
    try {
      parsed = JSON.parse(asset.raw)
    } catch {
      return []
    }
    const names: string[] = []
    for (const f of parsed.assetFormats ?? []) {
      const t = f.assetFormatType
      const label = typeof t?.name === 'string' ? t.name : typeof t?.code === 'string' ? t.code : null
      if (label && !names.includes(label)) names.push(label)
    }
    return names
  }

  /** Tooltip explaining why the Download button isn't there. */
  function notDownloadableReason(asset: AssetRow): string {
    const formats = fabFormatsFor(asset)
    const shipped = formats.length > 0 ? ` This listing ships as ${formats.join(', ')}.` : ''
    return (
      'ReHoarder can only download Unreal Engine builds, and this listing has none.' +
      shipped +
      ' Click to open it on Fab.'
    )
  }

  /**
   * Map `<source>:<sourceId>` → set of engine versions already downloaded
   * (status='done' in the downloads table). For asset cards with no version
   * breakdown (Fab Other) we store the sentinel `'*'` so the standalone
   * Download chip can still flip green.
   *
   * Re-fetched on mount and on every `downloads:state-changed` broadcast, so
   * a brand-new "done" row reflects in the cards without an explicit reload.
   */
  // Downloads snapshot lives in the singleton `downloadsStore`: the IPC fetch
  // runs once per app session and the broadcast listeners are attached at
  // module load. Asset cards remounting on tab switch read off the cache.
  const allDownloads = $derived(downloadsStore.all)
  onMount(() => {
    void downloadsStore.ensureLoaded()
  })

  /** `<source>:<sourceId>` → set of completed engine version slugs (`'*'` for generic / Fab Other). */
  const downloadedByAsset = $derived.by(() => {
    const map = new Map<string, Set<string>>()
    for (const row of allDownloads) {
      if (row.status !== 'done') continue
      const key = `${row.source}:${row.sourceId}`
      let bucket = map.get(key)
      if (!bucket) {
        bucket = new Set<string>()
        map.set(key, bucket)
      }
      bucket.add(row.engineVersion ?? '*')
    }
    return map
  })

  /**
   * Map `<source>:<sourceId>` → map of engine version slug → `buildVersion`
   * of the binary that was unpacked. Lets us detect "update available" by
   * comparing with `projectVersions[i].buildVersion` in the current raw asset.
   */
  const downloadedBuildVersions = $derived.by(() => {
    const map = new Map<string, Map<string, string>>()
    for (const row of allDownloads) {
      if (row.status !== 'done' || !row.buildVersion) continue
      const key = `${row.source}:${row.sourceId}`
      let builds = map.get(key)
      if (!builds) {
        builds = new Map<string, string>()
        map.set(key, builds)
      }
      builds.set(row.engineVersion ?? '*', row.buildVersion)
    }
    return map
  })

  /** In-flight downloads keyed by `<source>:<sourceId>`. Drives the per-card progress bar. */
  const activeProgressByAsset = $derived.by(() => {
    const map = new Map<string, { bytesDone: number; bytesTotal: number; status: string }>()
    for (const row of allDownloads) {
      if (row.status !== 'running' && row.status !== 'queued') continue
      const key = `${row.source}:${row.sourceId}`
      // Prefer the row with the highest progress (most recent for that asset).
      const cur = map.get(key)
      if (
        !cur ||
        (row.status === 'running' && cur.status !== 'running') ||
        row.bytesDone > cur.bytesDone
      ) {
        map.set(key, {
          bytesDone: row.bytesDone,
          bytesTotal: row.bytesTotal,
          status: row.status
        })
      }
    }
    return map
  })

  /**
   * Expand the recorded download versions to every other engine version that
   * shares the same `projectVersion` entry. Fab regularly bundles one build for
   * several engine versions (`engineVersions: ["UE_4.27", "UE_5.0", "UE_5.1"]`),
   * and a download targeted at any of them covers them all. Without this the
   * chips would only flip green for the exact version the user clicked, even
   * though the binary on disk satisfies the others.
   */
  /**
   * Parse the asset raw once and return `engineVersions[]` map keyed by
   * `projectVersions[i]` index, plus the `buildVersion` of each entry. Used by
   * both downloaded-detection (sibling expansion) and update-detection.
   */
  interface ParsedProjectVersion {
    /** Slugs in lowercase, `UE_` stripped. */
    engineVersions: string[]
    buildVersion: string | null
  }
  function parseProjectVersions(asset: AssetRow): ParsedProjectVersion[] {
    if (!asset.raw) return []
    let parsed: {
      projectVersions?: Array<{ engineVersions?: string[]; buildVersion?: unknown }>
    }
    try {
      parsed = JSON.parse(asset.raw)
    } catch {
      return []
    }
    return (parsed.projectVersions ?? []).map((pv) => ({
      engineVersions: (pv.engineVersions ?? []).map((v) =>
        v.replace(/^UE_/i, '').toLowerCase()
      ),
      buildVersion: typeof pv.buildVersion === 'string' ? pv.buildVersion : null
    }))
  }

  function downloadProgressFor(
    asset: AssetRow
  ): { bytesDone: number; bytesTotal: number; status: string } | null {
    return activeProgressByAsset.get(`${asset.source}:${asset.sourceId}`) ?? null
  }

  function downloadedVersionsFor(asset: AssetRow): string[] {
    const bucket = downloadedByAsset.get(`${asset.source}:${asset.sourceId}`)
    if (!bucket) return []
    const expanded = new Set<string>(bucket)
    const versions = parseProjectVersions(asset)
    for (const slug of bucket) {
      if (slug === '*') continue
      const wanted = slug.toLowerCase()
      for (const pv of versions) {
        if (pv.engineVersions.includes(wanted)) {
          for (const sib of pv.engineVersions) expanded.add(sib)
        }
      }
    }
    return [...expanded]
  }

  /**
   * Versions that are *downloaded* but whose latest published `buildVersion`
   * differs from what we have on disk. Expanded across sibling engine versions
   * in the same `projectVersion` entry (same build → same staleness).
   *
   * Heuristic: when the recorded download has no `buildVersion` (legacy rows
   * from before the migration) we skip the comparison — we can't tell.
   */
  function updatableVersionsFor(asset: AssetRow): string[] {
    const key = `${asset.source}:${asset.sourceId}`
    const builds = downloadedBuildVersions.get(key)
    if (!builds || builds.size === 0) return []
    const versions = parseProjectVersions(asset)
    const updatable = new Set<string>()
    for (const [slug, downloadedBuild] of builds) {
      if (slug === '*') continue
      const wanted = slug.toLowerCase()
      for (const pv of versions) {
        if (!pv.engineVersions.includes(wanted)) continue
        if (pv.buildVersion && pv.buildVersion !== downloadedBuild) {
          for (const sib of pv.engineVersions) updatable.add(sib)
        }
      }
    }
    return [...updatable]
  }

  /** Custom Install menu state — open per-asset, optionally pre-targeted to one engine version. */
  let customMenuAsset = $state<AssetRow | null>(null)
  let customMenuVersion = $state<string | undefined>(undefined)
  function openCustomInstall(asset: AssetRow, version: string | undefined): void {
    customMenuAsset = asset
    customMenuVersion = version
  }
  function closeCustomInstall(): void {
    customMenuAsset = null
    customMenuVersion = undefined
  }

  function formatListingType(slug: string): string {
    // `3d-model` → `3D Model`, `tool-and-plugin` → `Tool & Plugin`, etc.
    return slug
      .split('-')
      .map((p) => {
        if (p === 'and') return '&'
        if (/^\d/.test(p)) return p.toUpperCase()
        return p.charAt(0).toUpperCase() + p.slice(1)
      })
      .join(' ')
  }

  /** Re-uses listing-type formatter — same kebab→title-case convention. */
  function formatCategory(slug: string): string {
    return formatListingType(slug)
  }

  function formatLastSync(): string {
    const times = Object.values(lastSync)
      .map((s) => s.at)
      .filter((n) => Number.isFinite(n) && n > 0)
    if (times.length === 0) return 'never'
    const newest = Math.max(...times)
    return new Date(newest).toLocaleString()
  }

  /**
   * Union of `engineVersions` across every `projectVersions[]` entry of a Fab asset.
   * Returns short labels like `5.6` (stripped of the `UE_` prefix), sorted numerically.
   */
  function engineVersionsFor(asset: AssetRow): string[] {
    if (asset.source !== 'fab' || !asset.raw) return []
    let parsed: { projectVersions?: Array<{ engineVersions?: string[] }> }
    try {
      parsed = JSON.parse(asset.raw)
    } catch {
      return []
    }
    const versions = parsed.projectVersions ?? []
    const set = new Set<string>()
    for (const pv of versions) {
      for (const v of pv.engineVersions ?? []) {
        const clean = v.replace(/^UE_/i, '').trim()
        if (clean) set.add(clean)
      }
    }
    return [...set].sort((a, b) =>
      a.localeCompare(b, undefined, { numeric: true })
    )
  }
</script>

<div class="sticky-header">
  <div class="filters">
    <input
      type="search"
      placeholder="Search…"
      value={search}
      oninput={(e) => onSearch((e.currentTarget as HTMLInputElement).value)}
    />
    <select
      value={sourceFilter}
      onchange={(e) =>
        onSourceFilter((e.currentTarget as HTMLSelectElement).value as SourceFilter)}
    >
      <option value="all">All sources</option>
      <option value="fab-ue">Only Fab UE</option>
      <option value="fab-other">Only Fab Other</option>
      <option value="downloaded">Only Downloaded</option>
      <option value="updatable">Only Updatable</option>
      <option value="bookmarks">Only Bookmarks</option>
      <option value="hidden">Only Hidden</option>
    </select>
    <select
      value={listingTypeFilter}
      onchange={(e) => onListingTypeFilter((e.currentTarget as HTMLSelectElement).value)}
      disabled={availableListingTypes.length === 0}
      title="Filter by Fab listing type"
    >
      <option value="">All listing types</option>
      {#each availableListingTypes as t (t)}
        <option value={t}>{formatListingType(t)}</option>
      {/each}
    </select>
    <select
      value={categoryFilter}
      onchange={(e) => onCategoryFilter((e.currentTarget as HTMLSelectElement).value)}
      disabled={availableCategories.length === 0}
      title="Filter by Fab category"
    >
      <option value="">All categories</option>
      {#each availableCategories as c (c)}
        <option value={c}>{formatCategory(c)}</option>
      {/each}
    </select>
    <div class="filters-spacer"></div>
    <span class="sync-time" title="{countsBySource.fab ?? 0} Fab assets">
      Last synced {formatLastSync()}
    </span>
    <button
      type="button"
      class="sync-btn"
      disabled={syncBusy}
      onclick={() => onSyncNow()}
    >
      {syncBusy ? (progressText ?? 'Syncing…') : 'Sync now'}
    </button>
  </div>
</div>

<div class="grid" bind:this={gridEl} style:--card-w="{cardWidth}px">
  {#each assets as a (a.source + ':' + a.sourceId)}
    {@const versions = engineVersionsFor(a)}
    {@const plugin = isPlugin(a)}
    <AssetCard
      title={a.title}
      description={a.description}
      imageUrl={a.imageUrl}
      productUrl={a.productUrl}
      source={a.source}
      hidden={a.hidden}
      bookmarked={a.bookmarked}
      showSourceBadge={mixedSources}
      seller={a.seller}
      engineVersions={versions}
      installedEngineVersions={installedEngineVersions}
      downloadedVersions={downloadedVersionsFor(a)}
      updatableVersions={updatableVersionsFor(a)}
      downloadProgress={downloadProgressFor(a)}
      assetKind={assetKindFor(a)}
      isPlugin={plugin}
      onToggleHidden={() => onToggleHidden(a)}
      onToggleBookmark={() => onToggleBookmark(a)}
      onRefreshFromFab={a.source === 'fab' ? () => onRefreshFromFab(a) : undefined}
      onDownloadVersion={a.source === 'fab' && versions.length > 0
        ? (v) =>
            window.api.downloads.enqueue(a.source, a.sourceId, a.title, {
              engineVersion: v
            })
        : undefined}
      onDownload={a.source === 'fab' && versions.length === 0 && isDownloadable(a)
        ? () => window.api.downloads.enqueue(a.source, a.sourceId, a.title)
        : undefined}
      externalOnlyReason={a.source === 'fab' && versions.length === 0 && !isDownloadable(a)
        ? notDownloadableReason(a)
        : null}
      onCustomInstall={a.source === 'fab' && (versions.length > 0 || isDownloadable(a))
        ? (v) => openCustomInstall(a, v)
        : undefined}
    />
  {/each}
</div>

{#if customMenuAsset}
  <CustomInstallMenu
    assetTitle={customMenuAsset.title}
    assetSource={customMenuAsset.source}
    assetSourceId={customMenuAsset.sourceId}
    requestedVersion={customMenuVersion}
    availableVersions={engineVersionsFor(customMenuAsset)}
    downloadedVersions={downloadedVersionsFor(customMenuAsset)}
    installedEngines={installedEngines}
    knownProjects={knownProjects}
    projectPaths={projectPaths}
    assetKind={assetKindFor(customMenuAsset)}
    isPlugin={isPlugin(customMenuAsset)}
    onClose={closeCustomInstall}
  />
{/if}

{#if assets.length === 0 && !syncBusy}
  <p class="empty-note">No assets match your filters.</p>
{/if}

{#if zoomHint}
  <div class="zoom-hint" role="status" aria-live="polite">
    <span>{zoomHint}</span>
    <span class="zh-tip">Ctrl+scroll · Ctrl+plus / Ctrl+minus · Ctrl+0 resets</span>
  </div>
{/if}

{#if syncError || syncLog.length > 0}
  <aside class="dock" class:dock-with-error={!!syncError}>
    {#if syncError}
      <div class="error-banner" role="alert">Sync failed: {syncError}</div>
    {/if}
    {#if syncLog.length > 0}
      <SyncLogPanel {syncLog} open={syncBusy} />
    {/if}
  </aside>
{/if}

<style>
  .sticky-header {
    position: sticky;
    /* The TabBar above is itself sticky `top: 0`. It publishes its measured
       height on `--tab-bar-height` (see TabBar.svelte) so the filter row sits
       flush below it regardless of font / padding changes. The fallback is a
       reasonable guess for the very first frame before the variable is set. */
    top: var(--tab-bar-height, 48px);
    z-index: 5;
    background: #1a1a1a;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.4);
  }

  .sync-time {
    color: #888;
    font-size: 0.75rem;
    white-space: nowrap;
  }

  .filters-spacer {
    flex: 1;
  }

  .sync-btn {
    background: linear-gradient(135deg, #c084fc 0%, #f472b6 100%);
    color: white;
    border: none;
    border-radius: 4px;
    padding: 0.4rem 0.9rem;
    font-size: 0.85rem;
    font-family: inherit;
    cursor: pointer;
  }

  .sync-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .dock {
    position: fixed;
    bottom: 0;
    left: 0;
    right: 0;
    background: #1a1a1a;
    border-top: 1px solid #333;
    box-shadow: 0 -4px 16px rgba(0, 0, 0, 0.5);
    z-index: 10;
  }

  .error-banner {
    background: #4a1a1a;
    color: #fca5a5;
    padding: 0.6rem 1.25rem;
    font-size: 0.85rem;
  }

  .filters {
    display: flex;
    gap: 0.75rem;
    align-items: center;
    padding: 0.75rem 1.25rem;
    background: #1a1a1a;
    border-bottom: 1px solid #2a2a2a;
  }

  input[type='search'],
  select {
    background: #232325;
    color: #e0e0e0;
    border: 1px solid #444;
    border-radius: 4px;
    padding: 0.35rem 0.6rem;
    font-size: 0.85rem;
  }

  input[type='search'] {
    flex: 1;
    max-width: 320px;
  }

  .grid {
    display: grid;
    /* `--card-w` is written inline by the component: it starts from the
       Settings Image size preset and is overridden by Ctrl+wheel / Ctrl+±
       zoom. The `min(…, 100%)` guard keeps a single card from overflowing a
       very narrow window. The fallback covers the first paint, before Settings
       has been read.

       The gap is deliberately a constant: zoom solves for the card width that
       yields one column more/less, and a gap that shifted with the card size
       would invalidate that solution right after it was applied. */
    grid-template-columns: repeat(auto-fill, minmax(min(var(--card-w, 260px), 100%), 1fr));
    gap: 1rem;
    padding: 1.25rem 1.25rem 6rem;
  }

  /* Ephemeral column-count readout after a zoom step. Pinned under the sticky
     filter bar, centred, and click-through so it never blocks a card. */
  .zoom-hint {
    position: fixed;
    top: calc(var(--tab-bar-height, 48px) + 4rem);
    left: 50%;
    transform: translateX(-50%);
    z-index: 30;
    display: flex;
    align-items: baseline;
    gap: 0.5rem;
    padding: 0.35rem 0.8rem;
    background: rgba(31, 31, 31, 0.95);
    border: 1px solid #3a3a3a;
    border-radius: 999px;
    box-shadow: 0 4px 14px rgba(0, 0, 0, 0.5);
    color: #e0e0e0;
    font-size: 0.82rem;
    pointer-events: none;
  }
  .zoom-hint .zh-tip {
    color: #777;
    font-size: 0.72rem;
  }

  .empty-note {
    color: #6b6b6b;
    text-align: center;
    padding: 2rem;
  }
</style>
