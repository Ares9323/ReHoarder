<script lang="ts">
  import { onMount } from 'svelte'
  import { settingsVersion } from '../stores/settings-events.svelte'
  import { vaultStore } from '../stores/vault.svelte'

  interface LocalVaultEntry {
    name: string
    friendlyName: string | null
    imageUrl: string | null
    path: string
    rootPath: string
    totalBytes: number
    fileCount: number
    lastModified: number
    hasData: boolean
  }

  // Filesystem-derived state lives in the singleton store — switching to
  // another tab and back doesn't re-walk the vault, only an explicit Rescan or
  // a Settings save does.
  const entries = $derived(vaultStore.entries)
  const vaultDirs = $derived(vaultStore.vaultDirs)
  const loading = $derived(vaultStore.loading)
  const error = $derived(vaultStore.error)
  let separateByPath = $state(false)
  let showThumbnails = $state(true)

  type SortKey = 'name' | 'size' | 'lastModified'
  type SortDir = 'asc' | 'desc'
  let sortBy = $state<SortKey>('lastModified')
  let sortDir = $state<SortDir>('desc')

  // Search uses a debounced "active" value so typing fast doesn't re-derive
  // the filtered list on every keystroke. 250ms matches the Assets tab.
  let searchInput = $state('')
  let searchActive = $state('')
  let searchTimer: ReturnType<typeof setTimeout> | null = null
  function onSearchInput(v: string): void {
    searchInput = v
    if (searchTimer !== null) clearTimeout(searchTimer)
    searchTimer = setTimeout(() => {
      searchTimer = null
      searchActive = v
    }, 250)
  }

  function matchesSearch(e: LocalVaultEntry, q: string): boolean {
    if (q === '') return true
    const haystack = `${e.friendlyName ?? ''} ${e.name} ${e.path}`.toLowerCase()
    return haystack.includes(q)
  }

  const filteredEntries = $derived.by(() => {
    const q = searchActive.trim().toLowerCase()
    if (q === '') return entries
    return entries.filter((e) => matchesSearch(e, q))
  })

  /**
   * Sort the entries by the active column, in the active direction. We
   * `[...entries].sort()` (no in-place mutation) so the derived doesn't
   * trip Svelte's "you mutated reactive state inside a derived" check.
   * When `separateByPath` is on, the same comparator runs per root group.
   */
  function sortEntries(rows: LocalVaultEntry[]): LocalVaultEntry[] {
    const list = [...rows]
    const dir = sortDir === 'asc' ? 1 : -1
    list.sort((a, b) => {
      switch (sortBy) {
        case 'name': {
          // Friendly name when present (matches what the user actually sees),
          // fall back to the folder name otherwise.
          const an = (a.friendlyName ?? a.name).toLowerCase()
          const bn = (b.friendlyName ?? b.name).toLowerCase()
          return an.localeCompare(bn, undefined, { numeric: true }) * dir
        }
        case 'size':
          return (a.totalBytes - b.totalBytes) * dir
        case 'lastModified':
        default:
          return (a.lastModified - b.lastModified) * dir
      }
    })
    return list
  }
  const sortedEntries = $derived(sortEntries(filteredEntries))
  const sortedEntriesByRoot = $derived.by(() => {
    const map = new Map<string, LocalVaultEntry[]>()
    for (const root of vaultDirs) map.set(root, [])
    for (const e of sortedEntries) {
      if (!map.has(e.rootPath)) map.set(e.rootPath, [])
      map.get(e.rootPath)!.push(e)
    }
    return map
  })

  function setSort(key: SortKey): void {
    if (sortBy === key) {
      sortDir = sortDir === 'asc' ? 'desc' : 'asc'
      return
    }
    sortBy = key
    // Sensible defaults: text → asc, numeric → desc (biggest first feels right
    // for Size and Last modified)
    sortDir = key === 'name' ? 'asc' : 'desc'
  }

  function sortGlyph(key: SortKey): string {
    if (sortBy !== key) return ''
    return sortDir === 'asc' ? ' ▲' : ' ▼'
  }

  async function loadSettings(): Promise<void> {
    try {
      const s = await window.api.settings.get()
      separateByPath = s.separateVaultsByPath
      showThumbnails = s.showVaultThumbnails
    } catch {
      // best-effort; UI falls back to defaults
    }
  }

  // First mount: pull settings (cheap) and ask the store to load only if it
  // hasn't already. Tab switches re-mount this component but hit the cache.
  onMount(() => {
    void loadSettings()
    void vaultStore.ensureLoaded()
  })

  // React to settings changes (vault paths might have moved) — but skip the
  // initial tick so the very first mount doesn't trigger a wasteful re-scan
  // on top of `ensureLoaded()`.
  let firstSettingsTick = true
  $effect(() => {
    settingsVersion()
    if (firstSettingsTick) {
      firstSettingsTick = false
      return
    }
    void loadSettings()
    void vaultStore.rescan()
  })

  function formatBytes(n: number): string {
    if (n < 1024) return n + ' B'
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB'
    if (n < 1024 * 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + ' MB'
    return (n / (1024 * 1024 * 1024)).toFixed(2) + ' GB'
  }

  function formatDate(ms: number): string {
    if (!ms) return '—'
    return new Date(ms).toLocaleString()
  }

  function totalBytes(): number {
    return entries.reduce((acc, e) => acc + e.totalBytes, 0)
  }
  function totalFiles(): number {
    return entries.reduce((acc, e) => acc + e.fileCount, 0)
  }

  async function reveal(entry: LocalVaultEntry): Promise<void> {
    const target = entry.hasData ? entry.path + '\\data' : entry.path
    await window.api.vault.openInExplorer(target)
  }

  /** Confirm-dialog state. Holds the entry the user wants to delete; null = closed. */
  let pendingDelete = $state<LocalVaultEntry | null>(null)
  let deleting = $state(false)
  let deleteError = $state<string | null>(null)

  function askDelete(entry: LocalVaultEntry): void {
    pendingDelete = entry
    deleteError = null
  }
  function cancelDelete(): void {
    if (deleting) return
    pendingDelete = null
    deleteError = null
  }
  async function confirmDelete(): Promise<void> {
    if (!pendingDelete) return
    const target = pendingDelete
    deleting = true
    deleteError = null
    try {
      const r = await window.api.vault.deleteEntry(target.path)
      if (!r.ok) {
        deleteError = r.error ?? 'Delete failed'
        return
      }
      // Optimistic UI: drop the row immediately so the user doesn't see the
      // entry hanging around during the rescan, and so a second delete click
      // can't accidentally land on the same (now-gone) entry.
      vaultStore.removeEntryOptimistic(target.path)
      pendingDelete = null
    } catch (err) {
      deleteError = err instanceof Error ? err.message : String(err)
    } finally {
      deleting = false
    }
  }

  /** Cruft-cleanup dialog state. Holds the target entry + the scan result we
   *  display to the user before letting them confirm the actual deletion. */
  interface CruftMatch {
    relPath: string
    size: number
  }
  let cruftTarget = $state<LocalVaultEntry | null>(null)
  let cruftMatches = $state<CruftMatch[]>([])
  let cruftTotalBytes = $state(0)
  let cruftScanning = $state(false)
  let cruftCleaning = $state(false)
  let cruftError = $state<string | null>(null)

  async function askCleanCruft(entry: LocalVaultEntry): Promise<void> {
    cruftTarget = entry
    cruftMatches = []
    cruftTotalBytes = 0
    cruftError = null
    cruftScanning = true
    try {
      const r = await window.api.vault.scanCruft(entry.path)
      if (!r.ok) {
        cruftError = r.error ?? 'Scan failed'
        return
      }
      cruftMatches = r.matches ?? []
      cruftTotalBytes = r.totalBytes ?? 0
    } catch (err) {
      cruftError = err instanceof Error ? err.message : String(err)
    } finally {
      cruftScanning = false
    }
  }

  function cancelCleanCruft(): void {
    if (cruftCleaning) return
    cruftTarget = null
    cruftMatches = []
    cruftTotalBytes = 0
    cruftError = null
  }

  async function confirmCleanCruft(): Promise<void> {
    if (!cruftTarget) return
    cruftCleaning = true
    cruftError = null
    try {
      const r = await window.api.vault.cleanCruft(cruftTarget.path)
      if (!r.ok) {
        cruftError = r.error ?? 'Clean failed'
        return
      }
      cruftTarget = null
      cruftMatches = []
      cruftTotalBytes = 0
      // Background rescan: the entry stays in the table but its file count /
      // size need refreshing. Closing the dialog is the priority — the user
      // shouldn't wait on the filesystem walk.
      void vaultStore.rescan()
    } catch (err) {
      cruftError = err instanceof Error ? err.message : String(err)
    } finally {
      cruftCleaning = false
    }
  }

</script>

<section>
  <header class="bar">
    <div class="lead">
      <h2>Local Vault</h2>
      <p class="explain">
        Scanned roots, in the order configured under <strong>Settings → Vault paths</strong>:
      </p>
      <div class="roots">
        {#each vaultDirs as p (p)}
          <span class="root">{p}</span>
        {/each}
        {#if vaultDirs.length === 0}<span class="root">—</span>{/if}
      </div>
    </div>
    <div class="stats">
      <input
        type="search"
        class="vault-search"
        placeholder="Search…"
        value={searchInput}
        oninput={(e) => onSearchInput((e.currentTarget as HTMLInputElement).value)}
      />
      <span>
        {#if searchActive !== ''}{filteredEntries.length} / {/if}{entries.length}
        {entries.length === 1 ? 'asset' : 'assets'}
      </span>
      <span>·</span>
      <span>{totalFiles()} files</span>
      <span>·</span>
      <span>{formatBytes(totalBytes())}</span>
      <button type="button" onclick={() => vaultStore.rescan()} disabled={loading}>
        {loading ? 'Loading…' : 'Refresh'}
      </button>
    </div>
  </header>

  {#if loading && entries.length === 0}
    <div class="state">Loading vault…</div>
  {:else if error}
    <div class="state error">{error}</div>
  {:else if entries.length === 0}
    <div class="state empty">
      Nothing downloaded yet. Hit "Download" on a Fab asset card and it will appear here.
    </div>
  {:else if separateByPath}
    {#each [...sortedEntriesByRoot] as [root, rows] (root)}
      {#if rows.length > 0}
        <div class="group-block">
          <h3 class="group-title">
            <span class="group-path">{root}</span>
            <span class="group-count">{rows.length}</span>
          </h3>
          {@render tableFor(rows)}
        </div>
      {/if}
    {/each}
  {:else}
    {@render tableFor(sortedEntries)}
  {/if}
</section>

{#if cruftTarget}
  {@const target = cruftTarget}
  <div
    class="confirm-backdrop"
    role="presentation"
    onclick={(e) => {
      if ((e.target as HTMLElement).classList.contains('confirm-backdrop')) cancelCleanCruft()
    }}
  >
    <div class="confirm-popup" role="dialog" aria-modal="true" aria-label="Clean cruft from asset">
      <h3>Clean cruft from this asset?</h3>
      <p>
        Scanning <code>{target.path}</code> for files matching your current cruft
        rules (defaults + extras + off-platform binaries when enabled).
      </p>
      {#if cruftScanning}
        <div class="state">Scanning…</div>
      {:else if cruftError}
        <div class="confirm-error">{cruftError}</div>
      {:else if cruftMatches.length === 0}
        <p>Nothing matched the current cruft rules. This asset is already clean.</p>
      {:else}
        <p>
          Found <strong>{cruftMatches.length}</strong> file{cruftMatches.length === 1 ? '' : 's'}
          totalling <strong>{formatBytes(cruftTotalBytes)}</strong>. Empty parent
          directories are removed afterwards.
        </p>
        <ul class="cruft-list">
          {#each cruftMatches.slice(0, 30) as m (m.relPath)}
            <li><code>{m.relPath}</code> <span class="cruft-size">{formatBytes(m.size)}</span></li>
          {/each}
          {#if cruftMatches.length > 30}
            <li class="cruft-more">…and {cruftMatches.length - 30} more</li>
          {/if}
        </ul>
      {/if}
      <div class="confirm-actions">
        <button type="button" class="ghost" onclick={cancelCleanCruft} disabled={cruftCleaning}>
          {cruftMatches.length === 0 || cruftError ? 'Close' : 'Cancel'}
        </button>
        {#if cruftMatches.length > 0 && !cruftError}
          <button
            type="button"
            class="danger-primary"
            onclick={confirmCleanCruft}
            disabled={cruftCleaning || cruftScanning}
          >
            {cruftCleaning ? 'Cleaning…' : `Delete ${cruftMatches.length} files`}
          </button>
        {/if}
      </div>
    </div>
  </div>
{/if}

{#if pendingDelete}
  {@const target = pendingDelete}
  <div
    class="confirm-backdrop"
    role="presentation"
    onclick={(e) => {
      if ((e.target as HTMLElement).classList.contains('confirm-backdrop')) cancelDelete()
    }}
  >
    <div class="confirm-popup" role="dialog" aria-modal="true" aria-label="Delete vault entry">
      <h3>Delete from vault?</h3>
      <p>
        This will permanently remove the folder
        <code>{target.path}</code>
        ({formatBytes(target.totalBytes)}, {target.fileCount} files) from disk.
        The corresponding download record will be cleared so the asset is no
        longer marked as <em>downloaded</em> on the Assets tab.
      </p>
      {#if deleteError}
        <div class="confirm-error">{deleteError}</div>
      {/if}
      <div class="confirm-actions">
        <button type="button" class="ghost" onclick={cancelDelete} disabled={deleting}>
          Cancel
        </button>
        <button
          type="button"
          class="danger-primary"
          onclick={confirmDelete}
          disabled={deleting}
        >
          {deleting ? 'Deleting…' : 'Delete'}
        </button>
      </div>
    </div>
  </div>
{/if}

{#snippet tableFor(rows: LocalVaultEntry[])}
  <table>
    <thead>
      <tr>
        <th class="name sortable" onclick={() => setSort('name')}>
          Name<span class="glyph">{sortGlyph('name')}</span>
        </th>
        <th class="num">Files</th>
        <th class="num sortable" onclick={() => setSort('size')}>
          Size<span class="glyph">{sortGlyph('size')}</span>
        </th>
        <th class="date sortable" onclick={() => setSort('lastModified')}>
          Last modified<span class="glyph">{sortGlyph('lastModified')}</span>
        </th>
        <th class="actions"></th>
      </tr>
    </thead>
    <tbody>
      {#each rows as e (e.path)}
        <tr class:incomplete={!e.hasData}>
          <td class="name">
            <div class="name-row">
              {#if showThumbnails}
                <div class="thumb">
                  {#if e.imageUrl}
                    <img src={e.imageUrl} alt="" loading="lazy" />
                  {:else}
                    <div class="thumb-placeholder">?</div>
                  {/if}
                </div>
              {/if}
              <div class="name-text">
                <span class="entry-name">{e.friendlyName ?? e.name}</span>
                {#if !e.hasData}<span class="badge">no data/</span>{/if}
                {#if e.friendlyName}<span class="folder-hint">{e.name}</span>{/if}
                <span class="path-hint">{e.path}</span>
              </div>
            </div>
          </td>
          <td class="num">{e.fileCount}</td>
          <td class="num">{formatBytes(e.totalBytes)}</td>
          <td class="date">{formatDate(e.lastModified)}</td>
          <td class="actions">
            <button type="button" onclick={() => reveal(e)}>Open</button>
            <button
              type="button"
              class="icon-btn"
              onclick={() => askCleanCruft(e)}
              aria-label="Clean cruft from this asset"
              title="Clean cruft (docs, vendor PDFs, off-platform binaries…)"
            >
              🧹
            </button>
            <button
              type="button"
              class="danger icon-btn"
              onclick={() => askDelete(e)}
              aria-label="Delete from vault"
              title="Delete from vault"
            >
              🗑
            </button>
          </td>
        </tr>
      {/each}
    </tbody>
  </table>
{/snippet}

<style>
  section {
    padding: 1.5rem;
    max-width: 1100px;
    margin: 0 auto;
  }
  .bar {
    display: flex;
    justify-content: space-between;
    align-items: flex-end;
    gap: 1rem;
    margin-bottom: 1rem;
    flex-wrap: wrap;
  }
  .lead h2 {
    margin: 0;
    font-size: 1.15rem;
    color: #fff;
  }
  .explain {
    margin: 0.25rem 0 0.35rem;
    color: #888;
    font-size: 0.78rem;
    max-width: 650px;
  }
  .roots {
    display: flex;
    flex-wrap: wrap;
    gap: 0.4rem;
  }
  .root {
    background: #1f1f1f;
    color: #888;
    border: 1px solid #2e2e2e;
    border-radius: 3px;
    padding: 0.15rem 0.5rem;
    font-family: ui-monospace, 'Cascadia Code', Consolas, monospace;
    font-size: 0.72rem;
  }
  .group-block {
    margin-bottom: 1.25rem;
  }
  .group-title {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    margin: 0 0 0.45rem;
    font-size: 0.78rem;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: #c084fc;
    font-weight: 600;
  }
  .group-path {
    font-family: ui-monospace, 'Cascadia Code', Consolas, monospace;
    color: #c0c0c0;
    text-transform: none;
    letter-spacing: 0;
    font-weight: 500;
  }
  .group-count {
    color: #777;
    font-size: 0.7rem;
    background: #1f1f1f;
    border: 1px solid #2e2e2e;
    border-radius: 999px;
    padding: 0.05rem 0.5rem;
  }
  .stats {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    color: #b0b0b0;
    font-size: 0.85rem;
  }
  .stats button {
    margin-left: 0.5rem;
    background: transparent;
    color: #c0c0c0;
    border: 1px solid #444;
    border-radius: 4px;
    padding: 0.3rem 0.7rem;
    font-size: 0.75rem;
    cursor: pointer;
  }
  .stats button:hover:not(:disabled) {
    color: #fff;
    border-color: #666;
  }
  .stats button:disabled {
    opacity: 0.5;
    cursor: progress;
  }
  .vault-search {
    background: #1a1a1a;
    border: 1px solid #3a3a3a;
    border-radius: 4px;
    color: #e0e0e0;
    padding: 0.3rem 0.6rem;
    font-family: inherit;
    font-size: 0.8rem;
    width: 220px;
  }
  .vault-search::placeholder {
    color: #666;
  }
  .vault-search:focus {
    outline: none;
    border-color: #c084fc;
  }
  .state {
    background: #242424;
    border: 1px solid #333;
    border-radius: 8px;
    padding: 2rem;
    color: #b0b0b0;
    text-align: center;
  }
  .state.error {
    color: #fca5a5;
    border-color: #5a2727;
  }
  table {
    width: 100%;
    border-collapse: collapse;
    background: #242424;
    border: 1px solid #333;
    border-radius: 8px;
    overflow: hidden;
    font-size: 0.85rem;
  }
  th,
  td {
    padding: 0.55rem 0.85rem;
    border-bottom: 1px solid #2a2a2a;
    text-align: left;
  }
  th {
    background: #1f1f1f;
    color: #888;
    font-weight: 600;
    font-size: 0.7rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  th.sortable {
    cursor: pointer;
    user-select: none;
  }
  th.sortable:hover {
    color: #c084fc;
  }
  .glyph {
    color: #c084fc;
    font-size: 0.65rem;
    margin-left: 0.15rem;
  }
  tr:last-child td {
    border-bottom: none;
  }
  tr.incomplete td {
    opacity: 0.6;
  }
  .num,
  .date {
    color: #b0b0b0;
    font-variant-numeric: tabular-nums;
  }
  .num {
    text-align: right;
    width: 1%;
    white-space: nowrap;
  }
  .date {
    width: 1%;
    white-space: nowrap;
  }
  .actions {
    width: 1%;
    text-align: right;
    white-space: nowrap;
  }
  .actions button {
    background: transparent;
    color: #a0a0a0;
    border: 1px solid #3a3a3a;
    border-radius: 4px;
    padding: 0.2rem 0.6rem;
    font-size: 0.72rem;
    cursor: pointer;
    font-family: inherit;
  }
  .actions button + button {
    margin-left: 0.3rem;
  }
  .actions button:hover {
    color: #fff;
    border-color: #555;
  }
  .actions button.danger {
    color: #fca5a5;
    border-color: #5a2727;
  }
  .actions button.danger:hover {
    color: #fff;
    background: #3a1f1f;
    border-color: #7a3838;
  }
  .actions button.icon-btn {
    padding: 0.2rem 0.45rem;
    font-size: 0.9rem;
    line-height: 1;
  }

  .confirm-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.6);
    z-index: 250;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .confirm-popup {
    background: #1a1a1a;
    border: 1px solid #5a2727;
    border-radius: 10px;
    padding: 1.2rem 1.3rem;
    max-width: 480px;
    box-shadow: 0 12px 36px rgba(0, 0, 0, 0.6);
  }
  .confirm-popup h3 {
    margin: 0 0 0.6rem;
    color: #fca5a5;
    font-size: 0.95rem;
  }
  .confirm-popup p {
    margin: 0 0 0.85rem;
    color: #c0c0c0;
    font-size: 0.82rem;
    line-height: 1.5;
  }
  .confirm-popup code {
    color: #d0d0d0;
    font-family: ui-monospace, 'Cascadia Code', Consolas, monospace;
    font-size: 0.75rem;
    word-break: break-all;
  }
  .confirm-error {
    background: #3a1f1f;
    border: 1px solid #5a2727;
    color: #fca5a5;
    border-radius: 4px;
    padding: 0.4rem 0.7rem;
    font-size: 0.78rem;
    margin-bottom: 0.7rem;
  }
  .confirm-actions {
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
  }
  .confirm-actions button {
    border: none;
    border-radius: 5px;
    padding: 0.45rem 1.1rem;
    font-family: inherit;
    font-size: 0.85rem;
    cursor: pointer;
  }
  .confirm-actions .ghost {
    background: transparent;
    color: #c0c0c0;
    border: 1px solid #444;
  }
  .confirm-actions .ghost:hover:not(:disabled) {
    color: #fff;
    border-color: #666;
  }
  .confirm-actions .danger-primary {
    background: linear-gradient(135deg, #fca5a5, #ef4444);
    color: #1a1a1a;
    font-weight: 600;
  }
  .confirm-actions .danger-primary:hover:not(:disabled) {
    filter: brightness(1.08);
  }
  .cruft-list {
    list-style: none;
    padding: 0;
    margin: 0 0 0.8rem 0;
    max-height: 240px;
    overflow-y: auto;
    border: 1px solid #2a2a2a;
    border-radius: 4px;
    background: #161616;
  }
  .cruft-list li {
    display: flex;
    justify-content: space-between;
    gap: 0.6rem;
    padding: 0.25rem 0.55rem;
    font-size: 0.8rem;
    border-bottom: 1px solid #222;
  }
  .cruft-list li:last-child {
    border-bottom: none;
  }
  .cruft-list code {
    color: #c0c0c0;
    overflow-wrap: anywhere;
  }
  .cruft-size {
    color: #888;
    font-variant-numeric: tabular-nums;
    flex-shrink: 0;
  }
  .cruft-more {
    color: #888;
    font-style: italic;
    justify-content: center;
  }
  .confirm-actions button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .name-row {
    display: flex;
    align-items: center;
    gap: 0.7rem;
  }
  .thumb {
    flex: 0 0 auto;
    width: 56px;
    height: 32px;
    border-radius: 4px;
    background: #1a1a1a;
    border: 1px solid #2a2a2a;
    overflow: hidden;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .thumb img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
  }
  .thumb-placeholder {
    color: #444;
    font-size: 0.85rem;
    font-family: ui-monospace, 'Cascadia Code', Consolas, monospace;
  }
  .name-text {
    min-width: 0;
    flex: 1;
  }
  .entry-name {
    color: #e0e0e0;
    word-break: break-all;
  }
  .folder-hint {
    margin-left: 0.5rem;
    color: #777;
    font-family: ui-monospace, 'Cascadia Code', Consolas, monospace;
    font-size: 0.7rem;
  }
  .path-hint {
    display: block;
    color: #777;
    font-size: 0.7rem;
    font-family: ui-monospace, 'Cascadia Code', Consolas, monospace;
    margin-top: 0.15rem;
    word-break: break-all;
  }
  .badge {
    margin-left: 0.5rem;
    font-size: 0.65rem;
    color: #888;
    background: #2a2a2a;
    border: 1px solid #333;
    border-radius: 3px;
    padding: 0.05rem 0.4rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
</style>
