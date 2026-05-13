<script lang="ts">
  import { onMount, onDestroy } from 'svelte'

  type DownloadStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled'

  interface DownloadRow {
    id: string
    source: string
    sourceId: string
    title: string
    status: DownloadStatus
    bytesDone: number
    bytesTotal: number
    filesDone: number
    filesTotal: number
    currentFile: string | null
    destDir: string | null
    error: string | null
    createdAt: number
    startedAt: number | null
    finishedAt: number | null
  }

  type StatusFilter = 'all' | DownloadStatus

  let rows = $state<DownloadRow[]>([])
  let filter = $state<StatusFilter>('all')
  let loading = $state(true)
  let actionError = $state<string | null>(null)

  let unsubState: (() => void) | null = null
  let unsubProgress: (() => void) | null = null

  async function refresh(): Promise<void> {
    const r = await window.api.downloads.list()
    rows = r.rows
    loading = false
  }

  onMount(async () => {
    unsubState = window.api.downloads.onStateChanged((next) => {
      rows = next
    })
    unsubProgress = window.api.downloads.onProgress((updated) => {
      // Splice the single updated row in place rather than calling refresh(),
      // so a 50-asset queue with one downloading row doesn't re-render the world
      // every 200ms. Identity is preserved when the row is found.
      const idx = rows.findIndex((r) => r.id === updated.id)
      if (idx >= 0) {
        const copy = rows.slice()
        copy[idx] = updated
        rows = copy
      }
    })
    await refresh()
  })

  onDestroy(() => {
    unsubState?.()
    unsubProgress?.()
  })

  function formatBytes(n: number): string {
    if (n < 1024) return n + ' B'
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB'
    if (n < 1024 * 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + ' MB'
    return (n / (1024 * 1024 * 1024)).toFixed(2) + ' GB'
  }

  function pct(row: DownloadRow): number {
    if (row.bytesTotal <= 0) return 0
    return Math.min(100, Math.round((row.bytesDone / row.bytesTotal) * 100))
  }

  function throughput(row: DownloadRow): string {
    if (row.status !== 'running' || !row.startedAt || row.bytesDone === 0) return ''
    const seconds = (Date.now() - row.startedAt) / 1000
    if (seconds < 0.5) return ''
    const bps = row.bytesDone / seconds
    return formatBytes(bps) + '/s'
  }

  function eta(row: DownloadRow): string {
    if (row.status !== 'running' || !row.startedAt || row.bytesDone === 0) return ''
    const seconds = (Date.now() - row.startedAt) / 1000
    if (seconds < 0.5) return ''
    const bps = row.bytesDone / seconds
    const remaining = row.bytesTotal - row.bytesDone
    if (bps <= 0 || remaining <= 0) return ''
    const etaSec = remaining / bps
    if (etaSec < 60) return `~${Math.round(etaSec)}s`
    if (etaSec < 3600) return `~${Math.round(etaSec / 60)}m`
    return `~${(etaSec / 3600).toFixed(1)}h`
  }

  const filteredRows = $derived(() => {
    if (filter === 'all') return rows
    return rows.filter((r) => r.status === filter)
  })

  const statusCounts = $derived(() => {
    const c: Record<DownloadStatus, number> = {
      queued: 0,
      running: 0,
      done: 0,
      failed: 0,
      cancelled: 0
    }
    for (const r of rows) c[r.status]++
    return c
  })

  async function cancel(row: DownloadRow): Promise<void> {
    actionError = null
    const r = await window.api.downloads.cancel(row.id)
    if (!r.ok) actionError = r.error ?? 'Cancel failed'
  }

  async function retry(row: DownloadRow): Promise<void> {
    actionError = null
    const r = await window.api.downloads.retry(row.id)
    if (!r.ok) actionError = r.error ?? 'Retry failed'
  }

  async function remove(row: DownloadRow): Promise<void> {
    actionError = null
    const r = await window.api.downloads.remove(row.id)
    if (!r.ok) actionError = r.error ?? 'Remove failed'
  }

  async function openFolder(row: DownloadRow): Promise<void> {
    if (!row.destDir) return
    actionError = null
    const r = await window.api.downloads.openInExplorer(row.destDir)
    if (!r.ok) actionError = r.error ?? 'Open failed'
  }

  async function clearCompleted(): Promise<void> {
    actionError = null
    await window.api.downloads.clearCompleted()
  }
</script>

<section>
  <header class="bar">
    <div class="lead">
      <h2>Downloads</h2>
      <p class="explain">
        Queued and historical downloads. One asset at a time runs; new entries land at
        the back of the queue. Destination is the first writable
        <strong>Settings → Vault paths</strong> entry.
      </p>
    </div>
    <div class="stats">
      <span>{rows.length} total</span>
      <button type="button" onclick={clearCompleted} disabled={loading}>Clear completed</button>
    </div>
  </header>

  {#if actionError}
    <div class="action-error">{actionError}</div>
  {/if}

  <div class="filters">
    <button class="filter" class:active={filter === 'all'} onclick={() => (filter = 'all')}>
      All <span class="count">{rows.length}</span>
    </button>
    <button
      class="filter"
      class:active={filter === 'running'}
      onclick={() => (filter = 'running')}
    >
      Running <span class="count">{statusCounts().running}</span>
    </button>
    <button class="filter" class:active={filter === 'queued'} onclick={() => (filter = 'queued')}>
      Queued <span class="count">{statusCounts().queued}</span>
    </button>
    <button class="filter" class:active={filter === 'done'} onclick={() => (filter = 'done')}>
      Done <span class="count">{statusCounts().done}</span>
    </button>
    <button class="filter" class:active={filter === 'failed'} onclick={() => (filter = 'failed')}>
      Failed <span class="count">{statusCounts().failed}</span>
    </button>
    <button
      class="filter"
      class:active={filter === 'cancelled'}
      onclick={() => (filter = 'cancelled')}
    >
      Cancelled <span class="count">{statusCounts().cancelled}</span>
    </button>
  </div>

  {#if loading}
    <div class="state">Loading…</div>
  {:else if filteredRows().length === 0}
    <div class="state empty">
      {#if rows.length === 0}
        Nothing here yet. Hit <strong>Download</strong> on a Fab asset card and it will queue up here.
      {:else}
        No downloads matching the current filter.
      {/if}
    </div>
  {:else}
    <ul class="list">
      {#each filteredRows() as row (row.id)}
        <li class="row" class:running={row.status === 'running'}>
          <div class="head">
            <span class="title">{row.title}</span>
            <span class="status-pill status-{row.status}">{row.status}</span>
          </div>

          {#if row.status === 'running' || (row.bytesTotal > 0 && row.status !== 'done')}
            <div class="progress-wrap">
              <div class="progress-bar">
                <div class="progress-fill" style:width="{pct(row)}%"></div>
              </div>
              <span class="pct">{pct(row)}%</span>
            </div>
          {/if}

          <div class="meta">
            <span class="meta-source">{row.source} · {row.sourceId}</span>
            {#if row.bytesTotal > 0}
              <span class="meta-sep">·</span>
              <span>{formatBytes(row.bytesDone)} / {formatBytes(row.bytesTotal)}</span>
            {/if}
            {#if row.filesTotal > 0}
              <span class="meta-sep">·</span>
              <span>{row.filesDone}/{row.filesTotal} files</span>
            {/if}
            {#if throughput(row)}
              <span class="meta-sep">·</span>
              <span class="meta-rate">{throughput(row)}</span>
            {/if}
            {#if eta(row)}
              <span class="meta-sep">·</span>
              <span class="meta-eta">{eta(row)}</span>
            {/if}
            {#if row.currentFile}
              <span class="meta-sep">·</span>
              <span class="meta-file" title={row.currentFile}>{row.currentFile}</span>
            {/if}
          </div>

          {#if row.error}
            <div class="row-error" title={row.error}>{row.error}</div>
          {/if}

          <div class="actions">
            {#if row.status === 'queued' || row.status === 'running'}
              <button type="button" onclick={() => cancel(row)}>Cancel</button>
            {/if}
            {#if row.status === 'failed' || row.status === 'cancelled'}
              <button type="button" onclick={() => retry(row)}>Retry</button>
            {/if}
            {#if row.destDir && (row.status === 'done' || row.status === 'running')}
              <button type="button" onclick={() => openFolder(row)}>Open</button>
            {/if}
            {#if row.status !== 'running'}
              <button type="button" class="muted" onclick={() => remove(row)}>Remove</button>
            {/if}
          </div>
        </li>
      {/each}
    </ul>
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
    margin-bottom: 0.75rem;
    flex-wrap: wrap;
  }
  .lead h2 {
    margin: 0;
    font-size: 1.15rem;
    color: #fff;
  }
  .explain {
    margin: 0.25rem 0 0;
    color: #888;
    font-size: 0.78rem;
    max-width: 650px;
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
  .action-error {
    background: #3a1f1f;
    border: 1px solid #5a2727;
    color: #fca5a5;
    border-radius: 6px;
    padding: 0.5rem 0.85rem;
    font-size: 0.8rem;
    margin-bottom: 0.75rem;
  }
  .filters {
    display: flex;
    flex-wrap: wrap;
    gap: 0.35rem;
    margin-bottom: 0.9rem;
  }
  .filter {
    background: #1f1f1f;
    color: #888;
    border: 1px solid #2e2e2e;
    border-radius: 999px;
    padding: 0.2rem 0.7rem;
    font-family: inherit;
    font-size: 0.75rem;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
  }
  .filter:hover {
    color: #ddd;
    border-color: #444;
  }
  .filter.active {
    background: #2a1f3a;
    color: #c084fc;
    border-color: #4a3268;
  }
  .filter .count {
    color: #666;
    font-size: 0.7rem;
    font-variant-numeric: tabular-nums;
  }
  .filter.active .count {
    color: #c084fc;
  }
  .state {
    background: #242424;
    border: 1px solid #333;
    border-radius: 8px;
    padding: 2rem;
    color: #b0b0b0;
    text-align: center;
  }
  .list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
  }
  .row {
    background: #242424;
    border: 1px solid #333;
    border-radius: 8px;
    padding: 0.75rem 0.95rem;
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
  }
  .row.running {
    border-color: #4a3268;
  }
  .head {
    display: flex;
    align-items: center;
    gap: 0.75rem;
  }
  .title {
    color: #e0e0e0;
    font-weight: 500;
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .status-pill {
    display: inline-block;
    font-size: 0.65rem;
    border-radius: 3px;
    padding: 0.05rem 0.45rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    font-weight: 600;
  }
  .status-queued {
    color: #888;
    background: #1f1f1f;
    border: 1px solid #333;
  }
  .status-running {
    color: #c084fc;
    background: #2a1f3a;
    border: 1px solid #4a3268;
  }
  .status-done {
    color: #86efac;
    background: #163524;
    border: 1px solid #28553a;
  }
  .status-failed {
    color: #fca5a5;
    background: #3a1f1f;
    border: 1px solid #5a2727;
  }
  .status-cancelled {
    color: #888;
    background: #1f1f1f;
    border: 1px dashed #444;
  }
  .progress-wrap {
    display: flex;
    align-items: center;
    gap: 0.65rem;
  }
  .progress-bar {
    flex: 1;
    background: #1a1a1a;
    border: 1px solid #2a2a2a;
    border-radius: 4px;
    height: 8px;
    overflow: hidden;
  }
  .progress-fill {
    height: 100%;
    background: linear-gradient(90deg, #c084fc, #f472b6);
    transition: width 0.2s ease;
  }
  .pct {
    font-size: 0.75rem;
    color: #c0c0c0;
    font-variant-numeric: tabular-nums;
    min-width: 38px;
    text-align: right;
  }
  .meta {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 0.35rem;
    color: #888;
    font-size: 0.75rem;
    font-variant-numeric: tabular-nums;
  }
  .meta-source {
    color: #777;
    font-family: ui-monospace, 'Cascadia Code', Consolas, monospace;
    font-size: 0.72rem;
  }
  .meta-sep {
    color: #444;
  }
  .meta-rate {
    color: #c084fc;
  }
  .meta-eta {
    color: #86efac;
  }
  .meta-file {
    color: #aaa;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 320px;
  }
  .row-error {
    color: #fca5a5;
    font-size: 0.72rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 0.35rem;
  }
  .actions button {
    background: transparent;
    color: #a0a0a0;
    border: 1px solid #3a3a3a;
    border-radius: 4px;
    padding: 0.2rem 0.65rem;
    font-size: 0.72rem;
    cursor: pointer;
    font-family: inherit;
  }
  .actions button:hover {
    color: #fff;
    border-color: #555;
  }
  .actions button.muted {
    color: #777;
  }
</style>
