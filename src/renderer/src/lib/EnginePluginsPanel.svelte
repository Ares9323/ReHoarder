<script lang="ts">
  import { untrack } from 'svelte'

  /** Local mirror of the EnginePluginRich type from preload. Kept here so the
   *  renderer tsconfig doesn't have to include the main-process source.
   *  Keep in sync with src/preload/index.d.ts. */
  interface EnginePluginRich {
    name: string
    friendlyName: string
    description: string
    category: string
    versionName: string
    upluginPath: string
    relativePath: string
    bucket: string
    iconUrl: string | null
    enabledByDefault: boolean
    installed: boolean
  }

  interface EngineInfo {
    name: string
    path: string
    version: string
    majorVersion: number
    changelist: number
    branchName: string
    editorExePath: string | null
    hasEditor: boolean
  }

  interface Props {
    engine: EngineInfo
    onClose: () => void
  }

  let { engine, onClose }: Props = $props()

  /** Snapshot of the on-disk state at load time. Pending changes diff against
   *  these so we can reset the row without re-loading + so "Apply" only
   *  touches files that actually moved. */
  let originalByPath = $state<Map<string, { enabledByDefault: boolean; installed: boolean }>>(
    new Map()
  )
  let plugins = $state<EnginePluginRich[]>([])
  let loading = $state(false)
  let saving = $state(false)
  let error = $state<string | null>(null)

  type Filter = 'all' | 'enabled' | 'installed' | 'modified'
  let filter = $state<Filter>('all')
  let searchInput = $state('')
  let searchActive = $state('')
  let searchTimer: ReturnType<typeof setTimeout> | null = null
  function onSearchInput(v: string): void {
    searchInput = v
    if (searchTimer !== null) clearTimeout(searchTimer)
    searchTimer = setTimeout(() => {
      searchTimer = null
      searchActive = v
    }, 200)
  }

  /** Refetch + reset pending edits. Called on mount and whenever the focused
   *  engine prop changes. */
  async function load(): Promise<void> {
    loading = true
    error = null
    try {
      const r = await window.api.engines.listPlugins(engine.path)
      if (!r.ok) {
        error = r.error ?? 'Failed to list plugins'
        plugins = []
        originalByPath = new Map()
        return
      }
      plugins = r.plugins ?? []
      const snap = new Map<string, { enabledByDefault: boolean; installed: boolean }>()
      for (const p of plugins) {
        snap.set(p.upluginPath, {
          enabledByDefault: p.enabledByDefault,
          installed: p.installed
        })
      }
      originalByPath = snap
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
    } finally {
      loading = false
    }
  }

  // Reload whenever the parent swaps to a different engine — the @const in the
  // parent stays referentially the same for a given path, so an engine change
  // surfaces here as a new `engine.path`. `untrack` keeps the parent's
  // re-renders from looping the effect when other props change shape.
  $effect(() => {
    const _ = engine.path
    untrack(() => {
      void load()
    })
  })

  /** Re-derives on every plugins-array mutation; safe because the array
   *  itself is replaced rather than mutated in place. */
  const modifiedCount = $derived(
    plugins.reduce((acc, p) => (isPluginModified(p) ? acc + 1 : acc), 0)
  )

  function isPluginModified(p: EnginePluginRich): boolean {
    const orig = originalByPath.get(p.upluginPath)
    if (!orig) return false
    return p.enabledByDefault !== orig.enabledByDefault || p.installed !== orig.installed
  }

  const filteredPlugins = $derived.by(() => {
    const q = searchActive.trim().toLowerCase()
    return plugins.filter((p) => {
      if (filter === 'enabled' && !p.enabledByDefault) return false
      if (filter === 'installed' && !p.installed) return false
      if (filter === 'modified' && !isPluginModified(p)) return false
      if (q === '') return true
      const hay =
        `${p.friendlyName} ${p.name} ${p.category} ${p.description} ${p.versionName}`.toLowerCase()
      return hay.includes(q)
    })
  })

  /** In-place flip of one row. Replaces the array entry (not mutates) so the
   *  $derived above re-runs and the `modified` count updates. */
  function togglePlugin(
    upluginPath: string,
    key: 'enabledByDefault' | 'installed',
    value: boolean
  ): void {
    plugins = plugins.map((p) =>
      p.upluginPath === upluginPath ? { ...p, [key]: value } : p
    )
  }

  function resetPlugin(upluginPath: string): void {
    const orig = originalByPath.get(upluginPath)
    if (!orig) return
    plugins = plugins.map((p) =>
      p.upluginPath === upluginPath
        ? { ...p, enabledByDefault: orig.enabledByDefault, installed: orig.installed }
        : p
    )
  }

  function resetAll(): void {
    plugins = plugins.map((p) => {
      const orig = originalByPath.get(p.upluginPath)
      if (!orig) return p
      return { ...p, enabledByDefault: orig.enabledByDefault, installed: orig.installed }
    })
  }

  async function applyChanges(): Promise<void> {
    if (saving) return
    const dirty = plugins.filter((p) => isPluginModified(p))
    if (dirty.length === 0) return
    saving = true
    error = null
    const failures: string[] = []
    try {
      for (const p of dirty) {
        const orig = originalByPath.get(p.upluginPath)
        const payload: {
          upluginPath: string
          enabledByDefault?: boolean
          installed?: boolean
        } = { upluginPath: p.upluginPath }
        if (orig && p.enabledByDefault !== orig.enabledByDefault) {
          payload.enabledByDefault = p.enabledByDefault
        }
        if (orig && p.installed !== orig.installed) {
          payload.installed = p.installed
        }
        const r = await window.api.engines.setPluginState(payload)
        if (!r.ok) {
          failures.push(`${p.friendlyName}: ${r.error ?? 'unknown error'}`)
        } else {
          // Successful save: bump the original snapshot so the row stops
          // showing as modified.
          const newSnap = new Map(originalByPath)
          newSnap.set(p.upluginPath, {
            enabledByDefault: r.enabledByDefault ?? p.enabledByDefault,
            installed: r.installed ?? p.installed
          })
          originalByPath = newSnap
        }
      }
      if (failures.length > 0) {
        error = `Some plugins failed:\n${failures.join('\n')}`
      }
    } finally {
      saving = false
    }
  }
</script>

<section class="panel">
  <header class="bar">
    <div class="lead">
      <h3>Engine Plugins · {engine.name}</h3>
      <p class="explain">
        Toggle <code>EnabledByDefault</code> / <code>Installed</code> on every
        <code>.uplugin</code> under <code>Engine/Plugins/</code>. Changes are written
        in place with a <code>.bak</code> safety net.
      </p>
    </div>
    <div class="stats">
      <span>
        {plugins.length} plugin{plugins.length === 1 ? '' : 's'}
      </span>
      {#if modifiedCount > 0}
        <span>·</span>
        <span class="modified-count">{modifiedCount} modified</span>
      {/if}
      <button type="button" onclick={() => void load()} disabled={loading || saving}>
        {loading ? 'Loading…' : 'Reload'}
      </button>
      <button
        type="button"
        class="primary"
        onclick={() => void applyChanges()}
        disabled={saving || modifiedCount === 0}
      >
        {saving ? 'Applying…' : 'Apply changes'}
      </button>
      <button type="button" onclick={onClose} disabled={saving} title="Close the plugin panel">×</button>
    </div>
  </header>

  <div class="toolbar">
    <input
      type="search"
      placeholder="Search plugin name, category, description…"
      value={searchInput}
      oninput={(e) => onSearchInput((e.currentTarget as HTMLInputElement).value)}
      disabled={loading}
    />
    <div class="filters">
      <button
        type="button"
        class="filter"
        class:active={filter === 'all'}
        onclick={() => (filter = 'all')}
      >
        All
      </button>
      <button
        type="button"
        class="filter"
        class:active={filter === 'enabled'}
        onclick={() => (filter = 'enabled')}
      >
        Enabled by default
      </button>
      <button
        type="button"
        class="filter"
        class:active={filter === 'installed'}
        onclick={() => (filter = 'installed')}
      >
        Installed
      </button>
      <button
        type="button"
        class="filter"
        class:active={filter === 'modified'}
        onclick={() => (filter = 'modified')}
        disabled={modifiedCount === 0}
      >
        Modified ({modifiedCount})
      </button>
      {#if modifiedCount > 0}
        <button type="button" class="ghost-small" onclick={resetAll} disabled={saving}>
          Reset all
        </button>
      {/if}
    </div>
  </div>

  {#if error}
    <div class="state err">{error}</div>
  {/if}

  {#if loading && plugins.length === 0}
    <div class="state">Loading plugins…</div>
  {:else if !loading && plugins.length === 0}
    <div class="state empty">
      No plugins found under <code>{engine.path}/Engine/Plugins/</code>.
    </div>
  {:else if filteredPlugins.length === 0}
    <div class="state empty">No plugins match the current filters.</div>
  {:else}
    <table>
      <thead>
        <tr>
          <th class="thumb"></th>
          <th class="name">Plugin</th>
          <th class="cat">Category</th>
          <th class="ver">Version</th>
          <th class="bucket">Bucket</th>
          <th class="flag">Enabled</th>
          <th class="flag">Installed</th>
          <th class="reset"></th>
        </tr>
      </thead>
      <tbody>
        {#each filteredPlugins as p (p.upluginPath)}
          {@const modified = isPluginModified(p)}
          <tr class:modified>
            <td class="thumb">
              {#if p.iconUrl}
                <img src={p.iconUrl} alt="" loading="lazy" />
              {:else}
                <div class="thumb-placeholder">?</div>
              {/if}
            </td>
            <td class="name">
              <span class="plugin-name" title={p.upluginPath}>{p.friendlyName}</span>
              {#if p.description}
                <span class="desc" title={p.description}>{p.description}</span>
              {/if}
            </td>
            <td class="cat">{p.category || '—'}</td>
            <td class="ver">{p.versionName || '—'}</td>
            <td class="bucket">{p.bucket || '—'}</td>
            <td class="flag">
              <input
                type="checkbox"
                checked={p.enabledByDefault}
                disabled={saving}
                onchange={(e) =>
                  togglePlugin(p.upluginPath, 'enabledByDefault', (e.currentTarget as HTMLInputElement).checked)}
              />
            </td>
            <td class="flag">
              <input
                type="checkbox"
                checked={p.installed}
                disabled={saving}
                onchange={(e) =>
                  togglePlugin(p.upluginPath, 'installed', (e.currentTarget as HTMLInputElement).checked)}
              />
            </td>
            <td class="reset">
              {#if modified}
                <button type="button" class="ghost-small" onclick={() => resetPlugin(p.upluginPath)}>
                  Reset
                </button>
              {/if}
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  {/if}
</section>

<style>
  .panel {
    margin-top: 1.5rem;
    background: #1c1c1c;
    border: 1px solid #2e2e2e;
    border-radius: 8px;
    padding: 1rem 1.1rem 1.1rem;
  }
  .bar {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 1rem;
    flex-wrap: wrap;
    margin-bottom: 0.8rem;
  }
  .lead h3 {
    margin: 0;
    color: #fff;
    font-size: 0.95rem;
  }
  .explain {
    margin: 0.25rem 0 0;
    color: #888;
    font-size: 0.78rem;
    max-width: 620px;
  }
  .explain code {
    color: #a0a0a0;
  }
  .stats {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    color: #b0b0b0;
    font-size: 0.85rem;
    flex-wrap: wrap;
  }
  .stats button {
    background: transparent;
    color: #c0c0c0;
    border: 1px solid #444;
    border-radius: 4px;
    padding: 0.3rem 0.7rem;
    font-size: 0.75rem;
    font-family: inherit;
    cursor: pointer;
  }
  .stats button:hover:not(:disabled) {
    color: #fff;
    border-color: #666;
  }
  .stats button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .stats .primary {
    background: linear-gradient(135deg, #c084fc, #f472b6);
    color: #fff;
    border: none;
    font-weight: 500;
  }
  .stats .primary:disabled {
    opacity: 0.45;
  }
  .modified-count {
    color: #c084fc;
    font-weight: 600;
  }
  .toolbar {
    display: flex;
    gap: 0.8rem;
    align-items: center;
    flex-wrap: wrap;
    margin-bottom: 0.7rem;
  }
  .toolbar input[type='search'] {
    background: #1a1a1a;
    border: 1px solid #3a3a3a;
    border-radius: 4px;
    color: #e0e0e0;
    padding: 0.35rem 0.6rem;
    font-family: inherit;
    font-size: 0.82rem;
    flex: 1;
    min-width: 240px;
  }
  .toolbar input[type='search']:focus {
    outline: none;
    border-color: #c084fc;
  }
  .filters {
    display: flex;
    gap: 0.35rem;
    flex-wrap: wrap;
  }
  .filter {
    background: transparent;
    color: #a0a0a0;
    border: 1px solid #3a3a3a;
    border-radius: 4px;
    padding: 0.3rem 0.7rem;
    font-size: 0.75rem;
    font-family: inherit;
    cursor: pointer;
  }
  .filter:hover:not(:disabled) {
    color: #fff;
    border-color: #555;
  }
  .filter.active {
    background: #2a213a;
    color: #fff;
    border-color: #c084fc;
  }
  .filter:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }
  .ghost-small {
    background: transparent;
    color: #a0a0a0;
    border: 1px solid #3a3a3a;
    border-radius: 4px;
    padding: 0.2rem 0.55rem;
    font-size: 0.7rem;
    font-family: inherit;
    cursor: pointer;
  }
  .ghost-small:hover:not(:disabled) {
    color: #fff;
    border-color: #555;
  }
  .state {
    background: #242424;
    border: 1px solid #333;
    border-radius: 6px;
    padding: 1.5rem;
    color: #b0b0b0;
    text-align: center;
    font-size: 0.85rem;
  }
  .state.err {
    color: #fca5a5;
    border-color: #5a2727;
    text-align: left;
    white-space: pre-wrap;
    margin-bottom: 0.6rem;
  }
  .state code {
    color: #a0a0a0;
  }
  table {
    width: 100%;
    border-collapse: collapse;
    background: #242424;
    border: 1px solid #333;
    border-radius: 6px;
    overflow: hidden;
    font-size: 0.83rem;
  }
  th,
  td {
    padding: 0.4rem 0.7rem;
    border-bottom: 1px solid #2a2a2a;
    text-align: left;
    vertical-align: middle;
  }
  th {
    background: #1f1f1f;
    color: #888;
    font-weight: 600;
    font-size: 0.68rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  tr:last-child td {
    border-bottom: none;
  }
  tr.modified td {
    background: #1f1d28;
  }
  td.thumb,
  th.thumb {
    width: 32px;
    padding-right: 0;
  }
  td.thumb img {
    width: 24px;
    height: 24px;
    border-radius: 3px;
    object-fit: cover;
    display: block;
  }
  td.thumb .thumb-placeholder {
    width: 24px;
    height: 24px;
    border-radius: 3px;
    background: #2a2a2a;
    color: #555;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 0.7rem;
  }
  td.name {
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
  }
  .plugin-name {
    color: #e0e0e0;
    font-weight: 500;
  }
  .desc {
    color: #777;
    font-size: 0.72rem;
    display: -webkit-box;
    -webkit-line-clamp: 1;
    -webkit-box-orient: vertical;
    overflow: hidden;
    max-width: 360px;
  }
  .cat,
  .bucket {
    color: #b0b0b0;
    font-size: 0.78rem;
  }
  .ver {
    color: #b0b0b0;
    font-variant-numeric: tabular-nums;
    width: 1%;
    white-space: nowrap;
  }
  .flag,
  th.flag {
    width: 1%;
    text-align: center;
  }
  .flag input[type='checkbox'] {
    cursor: pointer;
    width: 16px;
    height: 16px;
    accent-color: #c084fc;
  }
  .reset {
    width: 1%;
    text-align: right;
    white-space: nowrap;
  }
</style>
