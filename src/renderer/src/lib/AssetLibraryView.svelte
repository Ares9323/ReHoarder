<script lang="ts">
  import { onMount } from 'svelte'
  import AssetCard from './AssetCard.svelte'
  import SyncLogPanel from './SyncLogPanel.svelte'
  import CustomInstallMenu from './CustomInstallMenu.svelte'
  import { settingsVersion } from '../stores/settings-events.svelte'

  type AssetSource = 'vault' | 'fab' | 'legacy'
  type AssetSubSource = 'fab-ue' | 'fab-other' | null
  type SourceFilter = 'all' | 'fab-ue' | 'fab-other' | 'bookmarks' | 'hidden'

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
    onToggleBookmark
  }: Props = $props()

  // Short engine version slugs (`5.4`, `4.27`) for engines the user has installed.
  // Used by AssetCard to decide whether a version chip click goes through the
  // "fast path" (auto-route + enqueue) or opens the Custom Install menu.
  let installedEngineVersions = $state<string[]>([])
  // The full engine info list is forwarded into the Custom Install menu so the
  // user can pick a target engine. We fetch once on mount and on every settings
  // change (paths may have moved) — same pattern as the other tabs.
  interface EngineLite {
    name: string
    path: string
    version: string
    majorVersion: number
    editorExePath: string | null
    hasEditor: boolean
  }
  interface ProjectLite {
    name: string
    uprojectPath: string
    projectDir: string
    engineAssociation: string
  }
  let installedEngines = $state<EngineLite[]>([])
  let knownProjects = $state<ProjectLite[]>([])

  async function loadInstallTargets(): Promise<void> {
    try {
      const [eRes, pRes] = await Promise.all([
        window.api.engines.list(),
        window.api.projects.list()
      ])
      if (eRes.ok) {
        installedEngines = (eRes.engines ?? []).map((e) => ({
          name: e.name,
          path: e.path,
          version: e.version,
          majorVersion: e.majorVersion,
          editorExePath: e.editorExePath,
          hasEditor: e.hasEditor
        }))
        installedEngineVersions = [
          ...new Set(installedEngines.map((e) => e.version.split('.').slice(0, 2).join('.')))
        ].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
      }
      if (pRes.ok) {
        knownProjects = (pRes.projects ?? []).map((p) => ({
          name: p.name,
          uprojectPath: p.uprojectPath,
          projectDir: p.projectDir,
          engineAssociation: p.engineAssociation
        }))
      }
    } catch {
      // Best-effort; the UI degrades to "always show Custom" if engines aren't known.
    }
  }

  onMount(loadInstallTargets)
  $effect(() => {
    settingsVersion()
    void loadInstallTargets()
  })

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
   * Map `<source>:<sourceId>` → set of engine versions already downloaded
   * (status='done' in the downloads table). For asset cards with no version
   * breakdown (Fab Other) we store the sentinel `'*'` so the standalone
   * Download chip can still flip green.
   *
   * Re-fetched on mount and on every `downloads:state-changed` broadcast, so
   * a brand-new "done" row reflects in the cards without an explicit reload.
   */
  let downloadedByAsset = $state<Map<string, Set<string>>>(new Map())
  /**
   * Map `<source>:<sourceId>` → map of engine version slug → `buildVersion`
   * of the binary that was unpacked. Lets us detect "update available" by
   * comparing with `projectVersions[i].buildVersion` in the current raw asset.
   * Keyed by the same sentinel `'*'` as `downloadedByAsset` for non-versioned
   * downloads (Fab Other).
   */
  let downloadedBuildVersions = $state<Map<string, Map<string, string>>>(new Map())
  async function loadDownloadedMap(): Promise<void> {
    try {
      const r = await window.api.downloads.list()
      const versionMap = new Map<string, Set<string>>()
      const buildMap = new Map<string, Map<string, string>>()
      for (const row of r.rows) {
        if (row.status !== 'done') continue
        const key = `${row.source}:${row.sourceId}`
        const verSlug = row.engineVersion ?? '*'
        let versions = versionMap.get(key)
        if (!versions) {
          versions = new Set<string>()
          versionMap.set(key, versions)
        }
        versions.add(verSlug)
        if (row.buildVersion) {
          let builds = buildMap.get(key)
          if (!builds) {
            builds = new Map<string, string>()
            buildMap.set(key, builds)
          }
          builds.set(verSlug, row.buildVersion)
        }
      }
      downloadedByAsset = versionMap
      downloadedBuildVersions = buildMap
    } catch {
      // best-effort; the chips just fall back to "no download status" styling
    }
  }
  onMount(() => {
    void loadDownloadedMap()
    const off = window.api.downloads.onStateChanged(() => {
      void loadDownloadedMap()
    })
    return off
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

<div class="grid">
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
      engineVersions={versions}
      installedEngineVersions={installedEngineVersions}
      downloadedVersions={downloadedVersionsFor(a)}
      updatableVersions={updatableVersionsFor(a)}
      assetKind={assetKindFor(a)}
      isPlugin={plugin}
      onToggleHidden={() => onToggleHidden(a)}
      onToggleBookmark={() => onToggleBookmark(a)}
      onDownloadVersion={a.source === 'fab' && versions.length > 0
        ? (v) =>
            window.api.downloads.enqueue(a.source, a.sourceId, a.title, {
              engineVersion: v
            })
        : undefined}
      onDownload={a.source === 'fab' && versions.length === 0
        ? () => window.api.downloads.enqueue(a.source, a.sourceId, a.title)
        : undefined}
      onCustomInstall={a.source === 'fab'
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
    assetKind={assetKindFor(customMenuAsset)}
    isPlugin={isPlugin(customMenuAsset)}
    onClose={closeCustomInstall}
  />
{/if}

{#if assets.length === 0 && !syncBusy}
  <p class="empty-note">No assets match your filters.</p>
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
    background: #242424;
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
    grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
    gap: 1rem;
    padding: 1.25rem 1.25rem 6rem;
  }

  .empty-note {
    color: #6b6b6b;
    text-align: center;
    padding: 2rem;
  }
</style>
