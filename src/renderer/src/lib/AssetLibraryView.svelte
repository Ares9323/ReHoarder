<script lang="ts">
  import AssetCard from './AssetCard.svelte'
  import SyncLogPanel from './SyncLogPanel.svelte'

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
    onSignOut: () => void
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
    onSignOut
  }: Props = $props()

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
  <header class="topbar">
    <div class="title">
      <strong>ReHoarder</strong>
      <span class="counts">
        {countsBySource.fab ?? 0} Fab assets
      </span>
      <span class="sync-time">Last synced {formatLastSync()}</span>
    </div>
    <div class="actions">
      <button type="button" disabled={syncBusy} onclick={() => onSyncNow()}>
        {syncBusy ? (progressText ?? 'Syncing…') : 'Sync now'}
      </button>
      <button type="button" class="secondary" onclick={() => onSignOut()}>Sign out</button>
    </div>
  </header>

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
  </div>
</div>

<div class="grid">
  {#each assets as a (a.source + ':' + a.sourceId)}
    <AssetCard
      title={a.title}
      description={a.description}
      imageUrl={a.imageUrl}
      productUrl={a.productUrl}
      source={a.source}
      hidden={a.hidden}
      bookmarked={a.bookmarked}
      engineVersions={engineVersionsFor(a)}
      onToggleHidden={() => onToggleHidden(a)}
      onToggleBookmark={() => onToggleBookmark(a)}
      onDownload={a.source === 'fab'
        ? () => window.api.downloads.enqueue(a.source, a.sourceId, a.title)
        : undefined}
    />
  {/each}
</div>

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
    top: 0;
    z-index: 5;
    background: #1a1a1a;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.4);
  }

  .topbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.75rem 1.25rem;
    border-bottom: 1px solid #333;
    background: #1f1f1f;
  }

  .title {
    display: flex;
    flex-direction: column;
  }

  .title strong {
    background: linear-gradient(135deg, #c084fc 0%, #f472b6 100%);
    -webkit-background-clip: text;
    background-clip: text;
    color: transparent;
    font-size: 1.05rem;
  }

  .counts,
  .sync-time {
    color: #a0a0a0;
    font-size: 0.75rem;
  }

  .actions {
    display: flex;
    gap: 0.5rem;
  }

  button {
    background: linear-gradient(135deg, #c084fc 0%, #f472b6 100%);
    color: white;
    border: none;
    border-radius: 4px;
    padding: 0.4rem 0.9rem;
    font-size: 0.85rem;
    cursor: pointer;
  }

  button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  button.secondary {
    background: transparent;
    border: 1px solid #444;
    color: #a0a0a0;
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
