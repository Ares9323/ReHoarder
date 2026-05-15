<script lang="ts">
  import { onMount } from 'svelte'
  import { settingsVersion } from '../stores/settings-events.svelte'
  import { projectsStore } from '../stores/projects.svelte'
  import UProjectEditorPanel from './UProjectEditorPanel.svelte'
  import SetAsTemplateDialog from './SetAsTemplateDialog.svelte'
  import DeepCleanDialog from './DeepCleanDialog.svelte'

  interface DeepCleanPreserve {
    editorPreferences: boolean
    assetCollections: boolean
    saveGames: boolean
    projectThumbnail: boolean
    localPackagedBuilds: boolean
  }

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
    rehoarderSource: string | null
    rehoarderSourceId: string | null
    imageUrl: string | null
  }

  type SortKey = 'name' | 'engine' | 'lastModified'
  type SortDir = 'asc' | 'desc'

  const projects = $derived(projectsStore.projects)
  const scannedPaths = $derived(projectsStore.scannedPaths)
  const loading = $derived(projectsStore.loading)
  const error = $derived(projectsStore.error)
  let separateByPath = $state(false)
  let showThumbnails = $state(true)

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

  async function loadSettings(): Promise<void> {
    try {
      const s = await window.api.settings.get()
      separateByPath = s.separateProjectsByPath
      showThumbnails = s.showProjectThumbnails
    } catch {
      // best-effort; UI falls back to defaults
    }
  }

  onMount(() => {
    void loadSettings()
    void projectsStore.ensureLoaded()
  })

  let firstSettingsTick = true
  $effect(() => {
    settingsVersion()
    if (firstSettingsTick) {
      firstSettingsTick = false
      return
    }
    void loadSettings()
    void projectsStore.rescan()
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
    void projectsStore.rescan()
  }

  /** When non-null, the Set-as-template dialog is open with this row preset. */
  let templatingProject = $state<ProjectInfo | null>(null)
  function startTemplating(p: ProjectInfo): void {
    templatingProject = p
  }
  function stopTemplating(): void {
    templatingProject = null
  }

  /**
   * Right-click context menu state. The row stays in `contextMenu.project`
   * so the menu items can dispatch against it even after the user moves the
   * cursor away. Position is fixed-viewport coordinates (clientX/Y).
   */
  let contextMenu = $state<{ x: number; y: number; project: ProjectInfo } | null>(null)
  /** DOM ref for the menu element so we can measure it after render and
   *  flip the position up / left when the click happened near the viewport
   *  edge. Without this the menu gets cropped by the window. */
  let contextMenuEl = $state<HTMLDivElement | null>(null)
  function openContextMenu(e: MouseEvent, p: ProjectInfo): void {
    e.preventDefault()
    contextMenu = { x: e.clientX, y: e.clientY, project: p }
  }
  function closeContextMenu(): void {
    contextMenu = null
    contextMenuEl = null
  }

  /**
   * Clamp the menu inside the viewport after it has been measured. Runs every
   * time the menu mounts (or its target ref binds) — we read its bounding
   * box, and if the bottom-right corner overflows, we shift the anchor up /
   * left enough to fit. 8 px margin so the menu doesn't kiss the edge.
   */
  $effect(() => {
    const cm = contextMenu
    const el = contextMenuEl
    if (!cm || !el) return
    const rect = el.getBoundingClientRect()
    const margin = 8
    let { x, y } = cm
    let needsUpdate = false
    if (rect.right > window.innerWidth - margin) {
      x = Math.max(margin, window.innerWidth - rect.width - margin)
      needsUpdate = true
    }
    if (rect.bottom > window.innerHeight - margin) {
      y = Math.max(margin, window.innerHeight - rect.height - margin)
      needsUpdate = true
    }
    if (needsUpdate) contextMenu = { ...cm, x, y }
  })
  function ctxEdit(): void {
    if (!contextMenu) return
    const p = contextMenu.project
    closeContextMenu()
    startEditing(p)
  }
  function ctxTemplate(): void {
    if (!contextMenu) return
    const p = contextMenu.project
    closeContextMenu()
    startTemplating(p)
  }

  /**
   * Per-action transient state. We keep an array so a slow Fix-redirectors
   * doesn't get its banner clobbered when the user kicks off a second action
   * — each promise stays live independently, and the user can see every
   * outcome instead of guessing whether the previous one finished. Banners
   * stack bottom-right; manual dismissal once the action is no longer
   * running.
   */
  type QuickActionStatus = 'running' | 'ok' | 'error'
  interface QuickActionEntry {
    id: number
    project: ProjectInfo
    label: string
    status: QuickActionStatus
    message: string | null
    /** Commandlet stdout/stderr tail when available — opens in a "Show output" modal. */
    output: string | null
  }
  let quickActions = $state<QuickActionEntry[]>([])
  let nextActionId = 0
  /** Output viewer modal target; non-null = open against that entry. */
  let viewingOutput = $state<QuickActionEntry | null>(null)

  /** Deep clean modal target; non-null = dialog open against that project. */
  let deepCleaning = $state<ProjectInfo | null>(null)

  function startQuickAction(p: ProjectInfo, label: string): number {
    const id = ++nextActionId
    quickActions = [
      ...quickActions,
      { id, project: p, label, status: 'running', message: null, output: null }
    ]
    return id
  }
  function endQuickAction(
    id: number,
    status: 'ok' | 'error',
    message: string,
    output: string | null = null
  ): void {
    quickActions = quickActions.map((a) =>
      a.id === id ? { ...a, status, message, output } : a
    )
  }
  function dismissQuickAction(id: number): void {
    quickActions = quickActions.filter((a) => a.id !== id)
  }

  function formatBytes(n: number): string {
    if (n < 1024) return `${n} B`
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
    if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`
    return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`
  }

  async function ctxCleanupRedirectors(): Promise<void> {
    if (!contextMenu) return
    const p = contextMenu.project
    closeContextMenu()
    const id = startQuickAction(p, 'Fixing redirectors')
    try {
      const r = await window.api.projects.cleanupRedirectors(p.uprojectPath)
      if (!r.ok) {
        endQuickAction(id, 'error', r.error ?? 'Cleanup commandlet failed', r.output || null)
        return
      }
      const engineNote = r.engineName ? ` via ${r.engineName}` : ''
      endQuickAction(id, 'ok', `Redirectors fixed${engineNote}.`, r.output || null)
    } catch (err) {
      endQuickAction(id, 'error', err instanceof Error ? err.message : String(err))
    }
  }

  async function ctxCleanBuildArtifacts(): Promise<void> {
    if (!contextMenu) return
    const p = contextMenu.project
    closeContextMenu()
    const id = startQuickAction(p, 'Deleting build artifacts')
    try {
      const r = await window.api.projects.cleanBuildArtifacts(p.projectDir)
      if (!r.ok) {
        endQuickAction(id, 'error', r.error ?? 'Clean failed')
        return
      }
      const freed = formatBytes(r.summary.deletedBytes)
      const n = r.summary.deletedPaths.length
      endQuickAction(id, 'ok', `Freed ${freed} across ${n} ${n === 1 ? 'path' : 'paths'}.`)
    } catch (err) {
      endQuickAction(id, 'error', err instanceof Error ? err.message : String(err))
    }
  }

  function ctxDeepClean(): void {
    if (!contextMenu) return
    const p = contextMenu.project
    closeContextMenu()
    deepCleaning = p
  }

  async function ctxCreateShortcut(): Promise<void> {
    if (!contextMenu) return
    const p = contextMenu.project
    closeContextMenu()
    const id = startQuickAction(p, 'Creating desktop shortcut')
    try {
      const r = await window.api.projects.createShortcut(p.uprojectPath)
      if (!r.ok) {
        endQuickAction(id, 'error', r.error ?? 'Could not create shortcut')
        return
      }
      endQuickAction(id, 'ok', `Shortcut written to ${r.shortcutPath}.`)
    } catch (err) {
      endQuickAction(id, 'error', err instanceof Error ? err.message : String(err))
    }
  }

  async function runDeepClean(preserve: DeepCleanPreserve): Promise<void> {
    const p = deepCleaning
    if (!p) return
    deepCleaning = null
    const id = startQuickAction(p, 'Deep cleaning')
    try {
      const r = await window.api.projects.deepClean({ projectDir: p.projectDir, preserve })
      if (!r.ok) {
        endQuickAction(id, 'error', r.error ?? 'Deep clean failed')
        return
      }
      const freed = formatBytes(r.summary.deletedBytes)
      const n = r.summary.deletedPaths.length
      const kept = r.summary.preservedPaths?.length ?? 0
      const keptNote = kept > 0 ? `, kept ${kept}` : ''
      endQuickAction(
        id,
        'ok',
        `Freed ${freed} across ${n} ${n === 1 ? 'path' : 'paths'}${keptNote}.`
      )
      // Refresh the projects scan so any thumbnail changes (e.g. user opted to
      // wipe AutoScreenshot.png) reflect in the cards immediately.
      void projectsStore.rescan()
    } catch (err) {
      endQuickAction(id, 'error', err instanceof Error ? err.message : String(err))
    }
  }

  $effect(() => {
    if (!contextMenu) return
    const onKey = (e: globalThis.KeyboardEvent): void => {
      if (e.key === 'Escape') closeContextMenu()
    }
    const onClick = (): void => closeContextMenu()
    window.addEventListener('keydown', onKey)
    // Use mousedown so the menu closes BEFORE the click reaches an underlying
    // element — feels snappier and matches how OS context menus dismiss.
    window.addEventListener('mousedown', onClick)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('mousedown', onClick)
    }
  })

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
      <button type="button" onclick={() => projectsStore.rescan()} disabled={loading}>
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

{#if templatingProject}
  {@const t = templatingProject}
  <SetAsTemplateDialog
    projectName={t.name}
    uprojectPath={t.uprojectPath}
    engineAssociation={t.engineAssociation || null}
    hasCode={t.hasCode}
    onClose={stopTemplating}
  />
{/if}

{#if contextMenu}
  {@const cm = contextMenu}
  <div
    bind:this={contextMenuEl}
    class="ctx-menu"
    role="menu"
    tabindex="-1"
    style:left="{cm.x}px"
    style:top="{cm.y}px"
    onmousedown={(e) => e.stopPropagation()}
  >
    <button type="button" role="menuitem" onclick={ctxEdit}>
      Edit .uproject descriptor
    </button>
    <button type="button" role="menuitem" onclick={ctxTemplate}>
      Use as engine template
    </button>
    <div class="ctx-divider"></div>
    <div class="ctx-group-label">Quick Actions</div>
    <button type="button" role="menuitem" onclick={() => void ctxCleanupRedirectors()}>
      Fix redirectors…
    </button>
    <button type="button" role="menuitem" onclick={() => void ctxCleanBuildArtifacts()}>
      Delete binaries &amp; caches
    </button>
    <button type="button" role="menuitem" onclick={ctxDeepClean}>
      Deep clean…
    </button>
    <div class="ctx-divider"></div>
    <button type="button" role="menuitem" onclick={() => void ctxCreateShortcut()}>
      Create desktop shortcut
    </button>
  </div>
{/if}

{#if deepCleaning}
  <DeepCleanDialog
    projectName={deepCleaning.name}
    onCancel={() => (deepCleaning = null)}
    onConfirm={(preserve) => void runDeepClean(preserve)}
  />
{/if}

{#if quickActions.length > 0}
  <div class="quick-action-stack">
    {#each quickActions as a (a.id)}
      <div
        class="quick-action-banner"
        class:busy={a.status === 'running'}
        class:error={a.status === 'error'}
      >
        <div class="qa-text">
          <strong>{a.project.name}</strong>
          <span class="qa-label">
            {#if a.status === 'running'}
              {a.label}… (this can take a while)
            {:else if a.status === 'error'}
              {a.label} failed — {a.message}
            {:else}
              {a.message}
            {/if}
          </span>
        </div>
        {#if a.output}
          <button
            type="button"
            class="qa-output"
            onclick={() => (viewingOutput = a)}
            title="Show commandlet output"
          >
            Show output
          </button>
        {/if}
        {#if a.status !== 'running'}
          <button
            type="button"
            class="qa-close"
            onclick={() => dismissQuickAction(a.id)}
            title="Dismiss"
          >×</button>
        {/if}
      </div>
    {/each}
  </div>
{/if}

{#if viewingOutput}
  {@const v = viewingOutput}
  <div class="output-backdrop" role="dialog" aria-modal="true" onmousedown={() => (viewingOutput = null)}>
    <div class="output-popup" onmousedown={(e) => e.stopPropagation()} role="document">
      <h3>
        <span class="output-action">{v.label}</span>
        <code>{v.project.name}</code>
      </h3>
      <p class="output-meta">
        {#if v.status === 'error'}
          <span class="output-status-err">Failed</span>
        {:else}
          <span class="output-status-ok">Completed</span>
        {/if}
        — last ~200 lines of commandlet output:
      </p>
      <pre class="output-pre">{v.output}</pre>
      <div class="output-actions">
        <button
          type="button"
          class="ghost"
          onclick={() => {
            if (v.output) void navigator.clipboard.writeText(v.output)
          }}
        >Copy</button>
        <button type="button" class="ghost" onclick={() => (viewingOutput = null)}>Close</button>
      </div>
    </div>
  </div>
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
        <tr
          class="row"
          oncontextmenu={(e) => openContextMenu(e, p)}
          title="Right-click for more actions"
        >
          <td class="kind">
            {#if p.hasCode}
              <span class="code-pill">C++</span>
            {:else}
              <span class="bp-pill">BP</span>
            {/if}
          </td>
          <td class="name">
            <div class="name-row">
              {#if showThumbnails}
                <div class="thumb">
                  {#if p.imageUrl}
                    <img src={p.imageUrl} alt="" loading="lazy" />
                  {:else}
                    <div class="thumb-placeholder">?</div>
                  {/if}
                </div>
              {/if}
              <div class="name-text">
                <span class="project-name">{p.name}</span>
                <span class="path-hint">{p.projectDir}</span>
                {#if st.error}
                  <span class="row-error" title={st.error}>{st.error}</span>
                {/if}
              </div>
            </div>
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
  /* Highlight the row under the cursor + nudge the pointer style so users
     discover the right-click menu without a banner explaining it. */
  tr.row {
    cursor: context-menu;
    transition: background-color 0.08s ease;
  }
  tr.row:hover td {
    background: #2d2d2d;
  }
  .ctx-menu {
    position: fixed;
    z-index: 400;
    min-width: 220px;
    background: #1f1f1f;
    border: 1px solid #3a3a3a;
    border-radius: 6px;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.55);
    padding: 0.25rem;
    display: flex;
    flex-direction: column;
  }
  .ctx-menu button {
    background: transparent;
    color: #d0d0d0;
    border: none;
    padding: 0.45rem 0.7rem;
    font-family: inherit;
    font-size: 0.85rem;
    text-align: left;
    border-radius: 4px;
    cursor: pointer;
  }
  .ctx-menu button:hover {
    background: #2a2a2a;
    color: #fff;
  }
  .ctx-divider {
    height: 1px;
    background: #2a2a2a;
    margin: 0.25rem 0.3rem;
  }
  .ctx-group-label {
    font-size: 0.65rem;
    color: #777;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    padding: 0.25rem 0.7rem 0.15rem;
  }
  .quick-action-stack {
    position: fixed;
    bottom: 1rem;
    right: 1rem;
    z-index: 350;
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
    align-items: flex-end;
    max-width: 520px;
  }
  .quick-action-banner {
    display: flex;
    align-items: center;
    gap: 0.55rem;
    width: 100%;
    background: #1f2a1f;
    border: 1px solid #2d4a2d;
    color: #c8f0c8;
    border-radius: 6px;
    padding: 0.55rem 0.85rem;
    font-size: 0.8rem;
    box-shadow: 0 6px 18px rgba(0, 0, 0, 0.55);
  }
  .quick-action-banner.busy {
    background: #1f1f2a;
    border-color: #3a3a55;
    color: #c0c0e0;
  }
  .quick-action-banner.error {
    background: #3a1f1f;
    border-color: #5a2727;
    color: #fca5a5;
  }
  .qa-text {
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
    flex: 1;
  }
  .qa-text strong {
    color: #fff;
    font-weight: 500;
    font-size: 0.82rem;
  }
  .qa-label {
    font-size: 0.75rem;
    opacity: 0.9;
  }
  .qa-close {
    background: transparent;
    border: 1px solid #444;
    color: #c0c0c0;
    border-radius: 3px;
    padding: 0 0.45rem;
    font-size: 0.95rem;
    line-height: 1.2;
    cursor: pointer;
    font-family: inherit;
  }
  .qa-close:hover {
    color: #fff;
    border-color: #666;
  }
  .qa-output {
    background: transparent;
    border: 1px solid #444;
    color: #c0c0c0;
    border-radius: 3px;
    padding: 0.15rem 0.55rem;
    font-size: 0.72rem;
    cursor: pointer;
    font-family: inherit;
  }
  .qa-output:hover {
    color: #fff;
    border-color: #c084fc;
  }
  .output-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.6);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 360;
  }
  .output-popup {
    background: #1f1f1f;
    border: 1px solid #3a3a3a;
    border-radius: 8px;
    box-shadow: 0 16px 48px rgba(0, 0, 0, 0.6);
    padding: 1rem 1.2rem 0.85rem;
    min-width: 640px;
    max-width: 80vw;
    max-height: 80vh;
    display: flex;
    flex-direction: column;
    color: #e0e0e0;
  }
  .output-popup h3 {
    margin: 0 0 0.4rem;
    font-size: 1rem;
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
  .output-popup h3 code {
    color: #c084fc;
    font-family: ui-monospace, 'Cascadia Code', Consolas, monospace;
    font-size: 0.9rem;
  }
  .output-action {
    font-weight: 500;
    color: #fff;
  }
  .output-meta {
    margin: 0 0 0.6rem;
    color: #b0b0b0;
    font-size: 0.78rem;
  }
  .output-status-ok {
    color: #86efac;
    font-weight: 600;
  }
  .output-status-err {
    color: #fca5a5;
    font-weight: 600;
  }
  .output-pre {
    flex: 1;
    background: #131313;
    border: 1px solid #2a2a2a;
    border-radius: 4px;
    padding: 0.6rem 0.75rem;
    margin: 0 0 0.85rem;
    overflow: auto;
    font-family: ui-monospace, 'Cascadia Code', Consolas, monospace;
    font-size: 0.72rem;
    line-height: 1.35;
    color: #d0d0d0;
    white-space: pre;
    max-height: 60vh;
  }
  .output-actions {
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
  }
  .output-actions button {
    background: transparent;
    border: 1px solid #444;
    color: #c0c0c0;
    border-radius: 4px;
    padding: 0.35rem 0.85rem;
    font-size: 0.82rem;
    font-family: inherit;
    cursor: pointer;
  }
  .output-actions button.ghost:hover {
    color: #fff;
    border-color: #666;
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
