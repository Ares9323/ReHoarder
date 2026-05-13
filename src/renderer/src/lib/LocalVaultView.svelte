<script lang="ts">
  import { settingsVersion } from '../stores/settings-events.svelte'

  interface LocalVaultEntry {
    name: string
    friendlyName: string | null
    path: string
    rootPath: string
    totalBytes: number
    fileCount: number
    lastModified: number
    hasData: boolean
  }

  let entries = $state<LocalVaultEntry[]>([])
  let vaultDirs = $state<string[]>([])
  let separateByPath = $state(false)
  let loading = $state(true)
  let error = $state<string | null>(null)

  async function load(): Promise<void> {
    loading = true
    error = null
    const [r, s] = await Promise.all([window.api.vault.list(), window.api.settings.get()])
    separateByPath = s.separateVaultsByPath
    if (r.ok) {
      entries = r.entries ?? []
      vaultDirs = r.vaultDirs ?? []
    } else {
      error = r.error ?? 'Failed to list vault'
    }
    loading = false
  }

  // Mount + re-scan on Settings save (vault paths can be added/removed live).
  $effect(() => {
    settingsVersion()
    void load()
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

  /** Group entries by `rootPath` preserving the configured roots order. */
  const entriesByRoot = $derived(() => {
    const map = new Map<string, LocalVaultEntry[]>()
    for (const root of vaultDirs) map.set(root, [])
    for (const e of entries) {
      if (!map.has(e.rootPath)) map.set(e.rootPath, [])
      map.get(e.rootPath)!.push(e)
    }
    return map
  })
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
  {:else if separateByPath}
    {#each [...entriesByRoot()] as [root, rows] (root)}
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
    {@render tableFor(entries)}
  {/if}
</section>

{#snippet tableFor(rows: LocalVaultEntry[])}
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
      {#each rows as e (e.path)}
        <tr class:incomplete={!e.hasData}>
          <td class="name">
            <span class="entry-name">{e.friendlyName ?? e.name}</span>
            {#if !e.hasData}<span class="badge">no data/</span>{/if}
            {#if e.friendlyName}<span class="folder-hint">{e.name}</span>{/if}
            <span class="path-hint">{e.path}</span>
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
