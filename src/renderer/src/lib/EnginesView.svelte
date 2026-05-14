<script lang="ts">
  import { onMount } from 'svelte'
  import { settingsVersion } from '../stores/settings-events.svelte'
  import { enginesStore } from '../stores/engines.svelte'
  import EnginePluginsPanel from './EnginePluginsPanel.svelte'

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

  const engines = $derived(enginesStore.engines)
  const scannedPaths = $derived(enginesStore.scannedPaths)
  const loading = $derived(enginesStore.loading)
  const error = $derived(enginesStore.error)

  /** The engine currently selected for the plugin panel below. Null until
   *  the user clicks a row or picks "Toggle plugins…" from the menu. */
  let focusedEngine = $state<EngineInfo | null>(null)
  /** Right-click menu position + target. Null = closed. */
  let contextMenu = $state<{ x: number; y: number; engine: EngineInfo } | null>(null)

  onMount(() => {
    void enginesStore.ensureLoaded()
  })

  let firstSettingsTick = true
  $effect(() => {
    settingsVersion()
    if (firstSettingsTick) {
      firstSettingsTick = false
      return
    }
    void enginesStore.rescan()
  })

  async function openInExplorer(engine: EngineInfo): Promise<void> {
    await window.api.engines.openInExplorer(engine.path)
  }

  async function openPluginFolder(engine: EngineInfo): Promise<void> {
    await window.api.engines.openInExplorer(engine.path + '/Engine/Plugins/Marketplace')
  }

  function focusEngine(engine: EngineInfo): void {
    focusedEngine = engine
  }

  function openContextMenu(e: MouseEvent, engine: EngineInfo): void {
    e.preventDefault()
    contextMenu = { x: e.clientX, y: e.clientY, engine }
  }

  function closeContextMenu(): void {
    contextMenu = null
  }

  function ctxOpen(): void {
    if (!contextMenu) return
    const eng = contextMenu.engine
    closeContextMenu()
    void openInExplorer(eng)
  }

  function ctxOpenPluginFolder(): void {
    if (!contextMenu) return
    const eng = contextMenu.engine
    closeContextMenu()
    void openPluginFolder(eng)
  }

  function ctxTogglePlugins(): void {
    if (!contextMenu) return
    const eng = contextMenu.engine
    closeContextMenu()
    focusEngine(eng)
  }

  $effect(() => {
    if (!contextMenu) return
    const onKey = (e: globalThis.KeyboardEvent): void => {
      if (e.key === 'Escape') closeContextMenu()
    }
    const onMouseDown = (): void => closeContextMenu()
    window.addEventListener('keydown', onKey)
    window.addEventListener('mousedown', onMouseDown)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('mousedown', onMouseDown)
    }
  })

  /**
   * Turn Epic's perforce-style branch name (`++UE5+Release-5.5`) into something
   * human-readable. The raw form is what UBT writes to Build.version, but it's
   * an internal P4 stream path — `++Project+Stream` markers don't mean anything
   * to a UE user. We strip the leading `++`, replace `+` with spaces, and
   * leave `-` alone (it separates Release-5.5 / Release-Live which the user
   * recognises that way). The original string is still in `engine.branchName`
   * if needed for diagnostics.
   */
  function formatBranch(raw: string): string {
    if (!raw) return '—'
    return raw.replace(/^\+\+/, '').replace(/\+/g, ' ').trim()
  }
</script>

<section>
  <header class="bar">
    <div class="lead">
      <h2>Engines</h2>
      <p class="explain">
        Scans every configured engine path for <code>UE_*/Engine/Build/Build.version</code>.
        Add or remove paths under <strong>Settings → Unreal Engine paths</strong>.
      </p>
    </div>
    <div class="stats">
      <span>{engines.length} {engines.length === 1 ? 'install' : 'installs'}</span>
      <button type="button" onclick={() => enginesStore.rescan()} disabled={loading}>
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

  {#if loading && engines.length === 0}
    <div class="state">Scanning configured paths…</div>
  {:else if error}
    <div class="state error">{error}</div>
  {:else if engines.length === 0}
    <div class="state empty">
      No Unreal Engine installs detected. Verify that the paths in Settings point to the folder
      that contains <code>UE_5.x</code> / <code>UE_4.x</code> subdirectories.
    </div>
  {:else}
    <table>
      <thead>
        <tr>
          <th class="name">Name</th>
          <th class="ver">Version</th>
          <th class="branch">Branch</th>
          <th class="num">Changelist</th>
          <th class="editor">Editor</th>
        </tr>
      </thead>
      <tbody>
        {#each engines as e (e.path)}
          <tr
            class="row"
            class:no-editor={!e.hasEditor}
            class:focused={focusedEngine?.path === e.path}
            onclick={() => focusEngine(e)}
            oncontextmenu={(ev) => openContextMenu(ev, e)}
            title="Click to manage plugins · right-click for more"
          >
            <td class="name">
              <span class="engine-name">{e.name}</span>
              <span class="path-hint">{e.path}</span>
            </td>
            <td class="ver">{e.version}</td>
            <td class="branch" title={e.branchName || ''}>{formatBranch(e.branchName)}</td>
            <td class="num">{e.changelist || '—'}</td>
            <td class="editor">
              {#if e.hasEditor}
                <span class="ok-pill">present</span>
              {:else}
                <span class="bad-pill">missing</span>
              {/if}
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  {/if}

  {#if focusedEngine}
    {@const f = focusedEngine}
    <EnginePluginsPanel engine={f} onClose={() => (focusedEngine = null)} />
  {/if}
</section>

{#if contextMenu}
  {@const cm = contextMenu}
  <div
    class="ctx-menu"
    role="menu"
    tabindex="-1"
    style:left="{cm.x}px"
    style:top="{cm.y}px"
    onmousedown={(e) => e.stopPropagation()}
  >
    <button type="button" role="menuitem" onclick={ctxOpen}>
      Open in Explorer
    </button>
    <button type="button" role="menuitem" onclick={ctxOpenPluginFolder}>
      Open plugin folder
    </button>
    <button type="button" role="menuitem" onclick={ctxTogglePlugins}>
      Toggle plugins enabled by default
    </button>
  </div>
{/if}

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
  .state code {
    color: #a0a0a0;
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
  tr.no-editor td {
    opacity: 0.65;
  }
  /* Make the row affordance for click + right-click discoverable.
     Hover gives a subtle highlight; the focused engine gets a stronger one
     plus an accent strip on the left so the user knows which engine the
     plugin panel below is targeting. */
  tr.row {
    cursor: context-menu;
    transition: background-color 0.08s ease;
  }
  tr.row:hover td {
    background: #2d2d2d;
  }
  tr.row.focused td {
    background: #2a213a;
  }
  tr.row.focused td:first-child {
    box-shadow: inset 3px 0 0 0 #c084fc;
  }
  .ctx-menu {
    position: fixed;
    z-index: 400;
    min-width: 240px;
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
  .num {
    color: #b0b0b0;
    font-variant-numeric: tabular-nums;
    text-align: right;
    width: 1%;
    white-space: nowrap;
  }
  .ver {
    color: #e0e0e0;
    font-variant-numeric: tabular-nums;
    font-weight: 600;
    width: 1%;
    white-space: nowrap;
  }
  .branch {
    color: #b0b0b0;
    font-family: ui-monospace, 'Cascadia Code', Consolas, monospace;
    font-size: 0.78rem;
  }
  .editor {
    width: 1%;
    white-space: nowrap;
  }
  .engine-name {
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
  .ok-pill,
  .bad-pill {
    display: inline-block;
    font-size: 0.68rem;
    border-radius: 3px;
    padding: 0.05rem 0.4rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .ok-pill {
    color: #86efac;
    background: #163524;
    border: 1px solid #28553a;
  }
  .bad-pill {
    color: #fca5a5;
    background: #3a1f1f;
    border: 1px solid #5a2727;
  }
</style>
