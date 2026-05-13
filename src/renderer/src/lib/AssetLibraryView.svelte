<script lang="ts">
  import AssetCard from './AssetCard.svelte'
  import SyncLogPanel from './SyncLogPanel.svelte'

  type AssetSource = 'vault' | 'fab' | 'legacy'

  interface AssetRow {
    source: AssetSource
    sourceId: string
    title: string
    description: string | null
    imageUrl: string | null
    productUrl: string | null
    ownedAt: number | null
    hidden: boolean
    raw: string | null
    syncedAt: number
  }

  interface Props {
    assets: AssetRow[]
    countsBySource: Record<string, number>
    lastSync: Record<string, { at: number; status: string; error: string | null }>
    search: string
    sourceFilter: AssetSource | 'all'
    showHidden: boolean
    syncBusy: boolean
    progressText: string | null
    syncError: string | null
    syncLog: string[]
    onSearch: (s: string) => void
    onSourceFilter: (f: AssetSource | 'all') => void
    onShowHidden: (v: boolean) => void
    onSyncNow: () => void
    onToggleHidden: (asset: AssetRow) => void
    onSignOut: () => void
  }

  let {
    assets,
    countsBySource,
    lastSync,
    search,
    sourceFilter,
    showHidden,
    syncBusy,
    progressText,
    syncError,
    syncLog,
    onSearch,
    onSourceFilter,
    onShowHidden,
    onSyncNow,
    onToggleHidden,
    onSignOut
  }: Props = $props()

  function formatLastSync(): string {
    const times = Object.values(lastSync)
      .map((s) => s.at)
      .filter((n) => Number.isFinite(n) && n > 0)
    if (times.length === 0) return 'never'
    const newest = Math.max(...times)
    return new Date(newest).toLocaleString()
  }
</script>

<div class="sticky-header">
  <header class="topbar">
    <div class="title">
      <strong>ReHoarder</strong>
      <span class="counts">
        {(countsBySource.vault ?? 0) + (countsBySource.fab ?? 0) + (countsBySource.legacy ?? 0)} assets
        ({countsBySource.vault ?? 0} Vault · {countsBySource.fab ?? 0} Fab)
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
        onSourceFilter((e.currentTarget as HTMLSelectElement).value as AssetSource | 'all')}
    >
      <option value="all">All sources</option>
      <option value="vault">Vault</option>
      <option value="fab">Fab</option>
    </select>
    <label class="show-hidden">
      <input
        type="checkbox"
        checked={showHidden}
        onchange={(e) => onShowHidden((e.currentTarget as HTMLInputElement).checked)}
      />
      Show hidden
    </label>
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
      onToggleHidden={() => onToggleHidden(a)}
      onDownload={a.source === 'fab'
        ? () => window.api.debug.downloadSampleAsset(a.sourceId)
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

  .show-hidden {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    color: #a0a0a0;
    font-size: 0.85rem;
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
