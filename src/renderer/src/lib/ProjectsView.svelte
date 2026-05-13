<script lang="ts">
  import { settingsVersion } from '../stores/settings-events.svelte'
  import UProjectEditorPanel from './UProjectEditorPanel.svelte'

  interface ProjectInfo {
    name: string
    uprojectPath: string
    projectDir: string
    rootPath: string
    engineAssociation: string
    description: string
    category: string
    hasCode: boolean
    lastModified: number
  }

  type SortKey = 'name' | 'engine' | 'lastModified'
  type SortDir = 'asc' | 'desc'

  let projects = $state<ProjectInfo[]>([])
  let scannedPaths = $state<string[]>([])
  let separateByPath = $state(false)
  let loading = $state(true)
  let error = $state<string | null>(null)

  let search = $state('')
  // Persisted across sessions in localStorage. We store the *hidden* set rather
  // than the visible set so that newly-detected engine versions are visible by
  // default (instead of silently filtered out because they weren't in the
  // persisted "visible" list).
  const HIDDEN_VERSIONS_KEY = 'rehoarder.projects.hiddenVersions'
  function loadHiddenVersions(): Set<string> {
    try {
      const raw = window.localStorage.getItem(HIDDEN_VERSIONS_KEY)
      if (!raw) return new Set()
      const arr = JSON.parse(raw)
      if (!Array.isArray(arr)) return new Set()
      return new Set(arr.filter((v): v is string => typeof v === 'string'))
    } catch {
      return new Set()
    }
  }
  let hiddenVersions = $state<Set<string>>(loadHiddenVersions())
  $effect(() => {
    try {
      window.localStorage.setItem(HIDDEN_VERSIONS_KEY, JSON.stringify([...hiddenVersions]))
    } catch {
      // storage full / disabled — silently ignore, filters just won't persist this session
    }
  })
  let sortBy = $state<SortKey>('lastModified')
  let sortDir = $state<SortDir>('desc')

  async function load(): Promise<void> {
    loading = true
    error = null
    const [r, s] = await Promise.all([
      window.api.projects.list(),
      window.api.settings.get()
    ])
    separateByPath = s.separateProjectsByPath
    if (r.ok) {
      projects = r.projects ?? []
      scannedPaths = r.scannedPaths ?? []
    } else {
      error = r.error ?? 'Failed to list projects'
    }
    loading = false
  }

  // Re-scan whenever settings are saved (so changing `projectPaths` or
  // `separateProjectsByPath` takes effect immediately without a restart)
  // and on mount.
  $effect(() => {
    settingsVersion()
    void load()
  })

  function formatDate(ms: number): string {
    if (!ms) return '—'
    return new Date(ms).toLocaleString()
  }

  /** Bucket key for the version chips. GUID-shaped associations collapse into a single "Source" bucket. */
  function engineBucket(s: string): string {
    if (!s) return 'Unknown'
    if (s.startsWith('{')) return 'Source'
    return s
  }

  function formatEngine(s: string): string {
    if (!s) return '—'
    if (s.startsWith('{')) return 'Source'
    return s
  }

  const availableVersions = $derived(() => {
    const set = new Set<string>()
    for (const p of projects) set.add(engineBucket(p.engineAssociation))
    return [...set].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
  })

  const filteredProjects = $derived(() => {
    const q = search.trim().toLowerCase()
    return projects.filter((p) => {
      if (hiddenVersions.has(engineBucket(p.engineAssociation))) return false
      if (q.length > 0 && !p.name.toLowerCase().includes(q)) return false
      return true
    })
  })

  const sortedProjects = $derived(() => {
    const list = [...filteredProjects()]
    const dir = sortDir === 'asc' ? 1 : -1
    list.sort((a, b) => {
      switch (sortBy) {
        case 'name':
          return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }) * dir
        case 'engine':
          return (
            engineBucket(a.engineAssociation).localeCompare(
              engineBucket(b.engineAssociation),
              undefined,
              { numeric: true }
            ) * dir
          )
        case 'lastModified':
        default:
          return (a.lastModified - b.lastModified) * dir
      }
    })
    return list
  })

  function toggleVersion(v: string): void {
    const next = new Set(hiddenVersions)
    if (next.has(v)) next.delete(v)
    else next.add(v)
    hiddenVersions = next
  }
  function showAllVersions(): void {
    hiddenVersions = new Set()
  }
  function hideAllVersions(): void {
    hiddenVersions = new Set(availableVersions())
  }
  function hideAllExcept(v: string): void {
    const next = new Set(availableVersions())
    next.delete(v)
    hiddenVersions = next
  }

  /** Group the sorted, filtered project list by `rootPath` (insertion order = `scannedPaths` order). */
  const projectsByRoot = $derived(() => {
    const map = new Map<string, ProjectInfo[]>()
    for (const root of scannedPaths) map.set(root, [])
    for (const p of sortedProjects()) {
      if (!map.has(p.rootPath)) map.set(p.rootPath, [])
      map.get(p.rootPath)!.push(p)
    }
    return map
  })

  function setSort(key: SortKey): void {
    if (sortBy === key) {
      sortDir = sortDir === 'asc' ? 'desc' : 'asc'
    } else {
      sortBy = key
      // sensible defaults per column
      sortDir = key === 'lastModified' ? 'desc' : 'asc'
    }
  }

  function sortGlyph(key: SortKey): string {
    if (sortBy !== key) return ''
    return sortDir === 'asc' ? ' ▲' : ' ▼'
  }

  async function reveal(p: ProjectInfo): Promise<void> {
    await window.api.projects.openInExplorer(p.projectDir)
  }

  // Side-panel editor state. Keyed by uprojectPath so when the panel closes we
  // can re-fetch the project's metadata (description/category may have changed).
  let editingPath = $state<string | null>(null)

  function startEditing(p: ProjectInfo): void {
    editingPath = p.uprojectPath
  }

  function stopEditing(): void {
    editingPath = null
    // Re-scan in case Description/Category changed — they show in the table.
    void load()
  }

  // Per-row transient action state: shows a busy indicator on the button that
  // was just clicked, and the IPC error if the launch failed (the error sits
  // next to the row buttons until the next action is taken).
  type ActionState = { busyAction: 'launch' | 'run' | null; error: string | null }
  let actionState = $state<Record<string, ActionState>>({})
  function getState(key: string): ActionState {
    return actionState[key] ?? { busyAction: null, error: null }
  }
  function setState(key: string, next: ActionState): void {
    actionState = { ...actionState, [key]: next }
  }

  async function launchEditor(p: ProjectInfo): Promise<void> {
    setState(p.uprojectPath, { busyAction: 'launch', error: null })
    try {
      const r = await window.api.projects.launchEditor(p.uprojectPath)
      setState(p.uprojectPath, { busyAction: null, error: r.ok ? null : r.error ?? 'Launch failed' })
    } catch (err) {
      setState(p.uprojectPath, {
        busyAction: null,
        error: err instanceof Error ? err.message : String(err)
      })
    }
  }

  async function runGame(p: ProjectInfo): Promise<void> {
    setState(p.uprojectPath, { busyAction: 'run', error: null })
    try {
      const r = await window.api.projects.runGame(p.uprojectPath)
      setState(p.uprojectPath, { busyAction: null, error: r.ok ? null : r.error ?? 'Run failed' })
    } catch (err) {
      setState(p.uprojectPath, {
        busyAction: null,
        error: err instanceof Error ? err.message : String(err)
      })
    }
  }
</script>

<section>
  <header class="bar">
    <div class="lead">
      <h2>Projects</h2>
      <p class="explain">
        Lists each subdirectory of the configured project paths that contains a
        <code>*.uproject</code>. Add or remove paths under <strong>Settings → Project paths</strong>.
      </p>
    </div>
    <div class="stats">
      <span>
        {sortedProjects().length} / {projects.length}
        {projects.length === 1 ? 'project' : 'projects'}
      </span>
      <button type="button" onclick={load} disabled={loading}>
        {loading ? 'Scanning…' : 'Rescan'}
      </button>
    </div>
  </header>

  {#if scannedPaths.length > 0}
    <div class="roots">
      {#each scannedPaths as p (p)}
        <span class="root">{p}</span>
      {/each}
    </div>
  {/if}

  {#if projects.length > 0}
    <div class="toolbar">
      <input
        type="search"
        class="search"
        placeholder="Filter by name…"
        bind:value={search}
        spellcheck="false"
      />
      <div class="chips">
        {#each availableVersions() as v (v)}
          <button
            type="button"
            class="chip"
            class:off={hiddenVersions.has(v)}
            ondblclick={() => hideAllExcept(v)}
            onclick={() => toggleVersion(v)}
            title="Click to toggle, double-click to isolate"
          >
            {v}
          </button>
        {/each}
        {#if availableVersions().length > 0}
          {#if hiddenVersions.size === 0}
            <button type="button" class="chip-reset" onclick={hideAllVersions}>Hide all</button>
          {:else}
            <button type="button" class="chip-reset" onclick={showAllVersions}>Show all</button>
          {/if}
        {/if}
      </div>
    </div>
  {/if}

  {#if loading && projects.length === 0}
    <div class="state">Scanning configured paths…</div>
  {:else if error}
    <div class="state error">{error}</div>
  {:else if projects.length === 0}
    <div class="state empty">
      No Unreal projects detected. Verify that the paths in Settings point to the folder
      that contains your project subdirectories.
    </div>
  {:else if sortedProjects().length === 0}
    <div class="state empty">No project matches the current filter.</div>
  {:else if separateByPath}
    {#each [...projectsByRoot()] as [root, rows] (root)}
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
    {@render tableFor(sortedProjects())}
  {/if}
</section>

{#if editingPath}
  <UProjectEditorPanel uprojectPath={editingPath} onClose={stopEditing} />
{/if}

{#snippet tableFor(rows: ProjectInfo[])}
  <table>
    <thead>
      <tr>
        <th class="kind">Kind</th>
        <th class="name sortable" onclick={() => setSort('name')}>
          Name<span class="glyph">{sortGlyph('name')}</span>
        </th>
        <th class="ver sortable" onclick={() => setSort('engine')}>
          Engine<span class="glyph">{sortGlyph('engine')}</span>
        </th>
        <th class="cat">Category</th>
        <th class="date sortable" onclick={() => setSort('lastModified')}>
          Last modified<span class="glyph">{sortGlyph('lastModified')}</span>
        </th>
        <th class="actions"></th>
      </tr>
    </thead>
    <tbody>
      {#each rows as p (p.uprojectPath)}
        {@const st = getState(p.uprojectPath)}
        <tr>
          <td class="kind">
            {#if p.hasCode}
              <span class="code-pill">C++</span>
            {:else}
              <span class="bp-pill">BP</span>
            {/if}
          </td>
          <td class="name">
            <span class="project-name">{p.name}</span>
            <span class="path-hint">{p.projectDir}</span>
            {#if st.error}
              <span class="row-error" title={st.error}>{st.error}</span>
            {/if}
          </td>
          <td class="ver">{formatEngine(p.engineAssociation)}</td>
          <td class="cat">{p.category || '—'}</td>
          <td class="date">{formatDate(p.lastModified)}</td>
          <td class="actions">
            <button
              type="button"
              class="btn-launch"
              disabled={st.busyAction !== null}
              onclick={() => launchEditor(p)}
              title="Open project in Unreal Editor"
            >
              {st.busyAction === 'launch' ? '…' : 'Launch'}
            </button>
            <button
              type="button"
              class="btn-run"
              disabled={st.busyAction !== null}
              onclick={() => runGame(p)}
              title="Launch in -game mode with the configured run params"
            >
              {st.busyAction === 'run' ? '…' : 'Run'}
            </button>
            <button type="button" onclick={() => startEditing(p)} title="Edit .uproject descriptor">
              Edit
            </button>
            <button type="button" onclick={() => reveal(p)}>Open</button>
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
  .explain code {
    color: #a0a0a0;
    font-size: 0.75rem;
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
  .roots {
    display: flex;
    flex-wrap: wrap;
    gap: 0.4rem;
    margin-bottom: 0.9rem;
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
  .toolbar {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    margin-bottom: 0.9rem;
    flex-wrap: wrap;
  }
  .search {
    background: #1a1a1a;
    border: 1px solid #3a3a3a;
    border-radius: 4px;
    color: #e0e0e0;
    padding: 0.35rem 0.7rem;
    font-family: inherit;
    font-size: 0.85rem;
    min-width: 220px;
    flex: 0 1 280px;
  }
  .search::placeholder {
    color: #666;
  }
  .search:focus {
    outline: none;
    border-color: #c084fc;
  }
  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: 0.35rem;
    align-items: center;
  }
  .chip {
    background: #2a1f3a;
    color: #c084fc;
    border: 1px solid #4a3268;
    border-radius: 999px;
    padding: 0.2rem 0.7rem;
    font-family: inherit;
    font-size: 0.75rem;
    cursor: pointer;
    user-select: none;
  }
  .chip:hover {
    border-color: #6b4994;
  }
  .chip.off {
    background: #1f1f1f;
    color: #666;
    border-color: #2e2e2e;
  }
  .chip.off:hover {
    color: #888;
  }
  .chip-reset {
    background: transparent;
    color: #888;
    border: 1px dashed #444;
    border-radius: 999px;
    padding: 0.2rem 0.7rem;
    font-family: inherit;
    font-size: 0.72rem;
    cursor: pointer;
  }
  .chip-reset:hover {
    color: #ddd;
    border-color: #666;
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
  .ver {
    color: #e0e0e0;
    font-variant-numeric: tabular-nums;
    font-weight: 600;
    width: 1%;
    white-space: nowrap;
  }
  .kind {
    width: 1%;
    white-space: nowrap;
  }
  .cat {
    color: #b0b0b0;
    font-size: 0.8rem;
  }
  .date {
    color: #b0b0b0;
    font-variant-numeric: tabular-nums;
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
  }
  .actions button + button {
    margin-left: 0.3rem;
  }
  .actions button:hover:not(:disabled) {
    color: #fff;
    border-color: #555;
  }
  .actions button:disabled {
    opacity: 0.5;
    cursor: progress;
  }
  .btn-launch {
    color: #c084fc !important;
    border-color: #4a3268 !important;
  }
  .btn-launch:hover:not(:disabled) {
    color: #d8b4fe !important;
    border-color: #6b4994 !important;
  }
  .btn-run {
    color: #86efac !important;
    border-color: #28553a !important;
  }
  .btn-run:hover:not(:disabled) {
    color: #bbf7d0 !important;
    border-color: #3e7a55 !important;
  }
  .row-error {
    display: block;
    margin-top: 0.3rem;
    color: #fca5a5;
    font-size: 0.7rem;
    max-width: 460px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .project-name {
    color: #e0e0e0;
    font-weight: 500;
  }
  .path-hint {
    display: block;
    color: #777;
    font-size: 0.72rem;
    font-family: ui-monospace, 'Cascadia Code', Consolas, monospace;
    margin-top: 0.15rem;
    word-break: break-all;
  }
  .code-pill,
  .bp-pill {
    display: inline-block;
    font-size: 0.68rem;
    border-radius: 3px;
    padding: 0.05rem 0.4rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    min-width: 2.4rem;
    text-align: center;
    box-sizing: border-box;
  }
  .code-pill {
    color: #fbbf77;
    background: #3a2a14;
    border: 1px solid #5a4128;
  }
  .bp-pill {
    color: #93c5fd;
    background: #1e2a3a;
    border: 1px solid #2a4566;
  }
</style>
