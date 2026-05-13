<script lang="ts">
  import { onMount } from 'svelte'

  interface LocalVaultEntry {
    name: string
    path: string
    totalBytes: number
    fileCount: number
    lastModified: number
    hasData: boolean
  }

  let entries = $state<LocalVaultEntry[]>([])
  let vaultDir = $state<string>('')
  let loading = $state(true)
  let error = $state<string | null>(null)

  async function load(): Promise<void> {
    loading = true
    error = null
    const r = await window.api.vault.list()
    if (r.ok) {
      entries = r.entries ?? []
      vaultDir = r.vaultDir ?? ''
    } else {
      error = r.error ?? 'Failed to list vault'
    }
    loading = false
  }

  onMount(load)

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
</script>

<section>
  <header class="bar">
    <div class="lead">
      <h2>Local Vault</h2>
      <p class="path">
        {#if vaultDir}{vaultDir}{:else}—{/if}
      </p>
    </div>
    <div class="stats">
      <span>{entries.length} {entries.length === 1 ? 'asset' : 'assets'}</span>
      <span>·</span>
      <span>{totalFiles()} files</span>
      <span>·</span>
      <span>{formatBytes(totalBytes())}</span>
      <button type="button" onclick={load} disabled={loading}>
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
  {:else}
    <table>
      <thead>
        <tr>
          <th class="name">Name</th>
          <th class="num">Files</th>
          <th class="num">Size</th>
          <th class="date">Last modified</th>
          <th class="actions"></th>
        </tr>
      </thead>
      <tbody>
        {#each entries as e (e.path)}
          <tr class:incomplete={!e.hasData}>
            <td class="name">
              <span class="entry-name">{e.name}</span>
              {#if !e.hasData}<span class="badge">no data/</span>{/if}
            </td>
            <td class="num">{e.fileCount}</td>
            <td class="num">{formatBytes(e.totalBytes)}</td>
            <td class="date">{formatDate(e.lastModified)}</td>
            <td class="actions">
              <button type="button" onclick={() => reveal(e)}>Open</button>
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  {/if}
</section>

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
  .path {
    margin: 0.25rem 0 0;
    font-family: ui-monospace, 'Cascadia Code', Consolas, monospace;
    font-size: 0.75rem;
    color: #888;
    word-break: break-all;
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
  }
  .actions button {
    background: transparent;
    color: #a0a0a0;
    border: 1px solid #3a3a3a;
    border-radius: 4px;
    padding: 0.2rem 0.6rem;
    font-size: 0.72rem;
    cursor: pointer;
  }
  .actions button:hover {
    color: #fff;
    border-color: #555;
  }
  .entry-name {
    color: #e0e0e0;
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
