<script lang="ts">
  import { settingsVersion } from '../stores/settings-events.svelte'

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

  let engines = $state<EngineInfo[]>([])
  let scannedPaths = $state<string[]>([])
  let loading = $state(true)
  let error = $state<string | null>(null)

  async function load(): Promise<void> {
    loading = true
    error = null
    const r = await window.api.engines.list()
    if (r.ok) {
      engines = r.engines ?? []
      scannedPaths = r.scannedPaths ?? []
    } else {
      error = r.error ?? 'Failed to list engines'
    }
    loading = false
  }

  // Re-scan whenever settings are saved (so changing `enginePaths` takes
  // effect immediately without a restart) and on mount.
  $effect(() => {
    settingsVersion()
    void load()
  })

  async function reveal(engine: EngineInfo): Promise<void> {
    await window.api.engines.openInExplorer(engine.path)
  }

  async function revealPlugins(engine: EngineInfo): Promise<void> {
    // path.resolve() in the main process normalises separators, so a forward
    // slash works on every platform — the guard checks startsWith on the
    // resolved engine roots, which still passes for this subpath.
    await window.api.engines.openInExplorer(engine.path + '/Engine/Plugins/Marketplace')
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
          <th class="actions"></th>
        </tr>
      </thead>
      <tbody>
        {#each engines as e (e.path)}
          <tr class:no-editor={!e.hasEditor}>
            <td class="name">
              <span class="engine-name">{e.name}</span>
              <span class="path-hint">{e.path}</span>
            </td>
            <td class="ver">{e.version}</td>
            <td class="branch">{e.branchName || '—'}</td>
            <td class="num">{e.changelist || '—'}</td>
            <td class="editor">
              {#if e.hasEditor}
                <span class="ok-pill">present</span>
              {:else}
                <span class="bad-pill">missing</span>
              {/if}
            </td>
            <td class="actions">
              <button type="button" onclick={() => reveal(e)}>Open</button>
              <button type="button" onclick={() => revealPlugins(e)}>Plugins</button>
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
    margin-left: 0.35rem;
  }
  .actions button:hover {
    color: #fff;
    border-color: #555;
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
