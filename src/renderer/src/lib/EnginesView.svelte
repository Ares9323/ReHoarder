<script lang="ts">
  import { onMount } from 'svelte'
  import { settingsVersion } from '../stores/settings-events.svelte'
  import { enginesStore } from '../stores/engines.svelte'
  import EnginePluginsPanel from './EnginePluginsPanel.svelte'
  import IniMasterPreviewDialog from './IniMasterPreviewDialog.svelte'
  import EngineDownloadDialog from './EngineDownloadDialog.svelte'

  interface EngineSku {
    appName: string
    catalogItemId: string
    namespace: string
    buildVersion: string
    shortVersion: string
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

  const engines = $derived(enginesStore.engines)
  const scannedPaths = $derived(enginesStore.scannedPaths)
  const loading = $derived(enginesStore.loading)
  const error = $derived(enginesStore.error)

  /** The engine currently selected for the plugin panel below. Null until
   *  the user clicks a row or picks "Toggle plugins…" from the menu. */
  let focusedEngine = $state<EngineInfo | null>(null)
  /** Right-click menu position + target. Null = closed. */
  let contextMenu = $state<{
    x: number
    y: number
    engine: EngineInfo
    /** Snapshotted at open time so the menu items can show/hide Restore. */
    editorSettings: { hasBackup: boolean; hasSentinel: boolean } | null
    keybindings: { hasBackup: boolean; hasSentinel: boolean } | null
  } | null>(null)
  let editorSettingsStatus = $state<string | null>(null)
  let editorSettingsError = $state<string | null>(null)
  let editorSettingsBusy = $state(false)
  /** Preview dialog state: which engine + which subject (editor settings vs keybindings). */
  let previewingEngine = $state<EngineInfo | null>(null)
  let previewSubject = $state<'editor-settings' | 'keybindings'>('editor-settings')

  /** "Install engine" picker — popover triggered by the Install engine button.
   *  Null = closed. The list is loaded lazily on first open and re-loaded after
   *  every successful install so it auto-updates as engines get installed. */
  let installPickerOpen = $state(false)
  let installerOwnedEngines = $state<EngineSku[] | null>(null)
  let installerOwnedLoading = $state(false)
  let installerOwnedError = $state<string | null>(null)
  /** The SKU the user picked → drives the EngineDownloadDialog. Null = dialog
   *  closed; non-null = dialog open against that SKU. */
  let installerSelectedSku = $state<EngineSku | null>(null)
  /** Toast surfaced once a confirm fires — task #15 hooks the real queue;
   *  for this commit we just show the user what would have been queued. */
  let installerFlash = $state<string | null>(null)

  onMount(() => {
    void enginesStore.ensureLoaded()
  })

  // Listen for "engine just finished installing" from main — the
  // post-install bookkeeping there has already appended the parent dir
  // to `enginePaths`, so we just have to invalidate caches + rescan.
  $effect(() => {
    const unsub = window.api.engineDownloads.onInstalled((info) => {
      installerOwnedEngines = null
      void enginesStore.rescan()
      const reg = info.postInstall.registryStatus
      const regNote =
        reg === 'ok'
          ? ' Registered with UnrealVersionSelector.'
          : reg === 'skipped'
            ? ''
            : reg && typeof reg === 'object' && 'error' in reg
              ? ` Registry write failed: ${reg.error}`
              : ''
      const pathNote = info.postInstall.enginePathAlreadyConfigured
        ? ''
        : ` Added ${info.postInstall.enginePathAdded} to engine paths.`
      flashInstaller(
        `${info.appName} installed at ${info.installDir}.${pathNote}${regNote}`
      )
    })
    return unsub
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

  /** Versions already on disk — `enginesStore.engines` is the locally-detected
   *  list, indexed by major.minor for dedup against owned SKUs. */
  const installedShortVersions = $derived.by(() => {
    const set = new Set<string>()
    for (const e of engines) {
      const m = /^(\d+)(?:\.(\d+))?/.exec(e.version)
      if (m) set.add(m[2] ? `${m[1]}.${m[2]}` : m[1])
    }
    return set
  })

  /** Owned SKUs minus the ones already installed on disk — used for the
   *  "Install engine…" picker dropdown. */
  const installablEngines = $derived(
    (installerOwnedEngines ?? []).filter((s) => !installedShortVersions.has(s.shortVersion))
  )

  async function ensureInstallerOwnedLoaded(force = false): Promise<void> {
    if (installerOwnedLoading) return
    if (installerOwnedEngines !== null && !force) return
    installerOwnedLoading = true
    installerOwnedError = null
    try {
      const r = await window.api.engineDownloads.listOwned()
      if (!r.ok) {
        installerOwnedError = r.error ?? 'Could not list owned engines'
        installerOwnedEngines = []
        return
      }
      installerOwnedEngines = r.engines ?? []
    } catch (err) {
      installerOwnedError = err instanceof Error ? err.message : String(err)
      installerOwnedEngines = []
    } finally {
      installerOwnedLoading = false
    }
  }

  async function toggleInstallPicker(): Promise<void> {
    if (installPickerOpen) {
      installPickerOpen = false
      return
    }
    installPickerOpen = true
    await ensureInstallerOwnedLoaded()
  }

  function pickEngineForInstall(sku: EngineSku): void {
    installPickerOpen = false
    installerSelectedSku = sku
  }

  function flashInstaller(msg: string): void {
    installerFlash = msg
    setTimeout(() => {
      if (installerFlash === msg) installerFlash = null
    }, 6000)
  }

  async function openPluginFolder(engine: EngineInfo): Promise<void> {
    await window.api.engines.openInExplorer(engine.path + '/Engine/Plugins/Marketplace')
  }

  function focusEngine(engine: EngineInfo): void {
    focusedEngine = engine
  }

  async function openContextMenu(e: MouseEvent, engine: EngineInfo): Promise<void> {
    e.preventDefault()
    contextMenu = {
      x: e.clientX,
      y: e.clientY,
      engine,
      editorSettings: null,
      keybindings: null
    }
    // Best-effort: fetch both editor-settings and keybindings status so the
    // menu can hide Restore items when there's nothing to restore from.
    // Either call failing is harmless — the menu still works.
    const [esRes, kbRes] = await Promise.all([
      window.api.engines.editorSettingsInfo(engine.path).catch(() => null),
      window.api.engines.keybindingsInfo(engine.path).catch(() => null)
    ])
    if (!contextMenu || contextMenu.engine.path !== engine.path) return
    contextMenu = {
      ...contextMenu,
      editorSettings: esRes?.ok
        ? { hasBackup: esRes.hasBackup, hasSentinel: esRes.hasSentinel }
        : null,
      keybindings: kbRes?.ok
        ? { hasBackup: kbRes.hasBackup, hasSentinel: kbRes.hasSentinel }
        : null
    }
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

  function flashEditorStatus(msg: string): void {
    editorSettingsStatus = msg
    window.setTimeout(() => {
      if (editorSettingsStatus === msg) editorSettingsStatus = null
    }, 4000)
  }

  function ctxPreviewEditorSettings(): void {
    if (!contextMenu) return
    const eng = contextMenu.engine
    closeContextMenu()
    previewSubject = 'editor-settings'
    previewingEngine = eng
  }

  function ctxPreviewKeybindings(): void {
    if (!contextMenu) return
    const eng = contextMenu.engine
    closeContextMenu()
    previewSubject = 'keybindings'
    previewingEngine = eng
  }

  async function ctxRestoreEditorSettings(): Promise<void> {
    if (!contextMenu || editorSettingsBusy) return
    const eng = contextMenu.engine
    closeContextMenu()
    editorSettingsBusy = true
    editorSettingsError = null
    try {
      const r = await window.api.engines.restoreEditorSettings(eng.path)
      if (!r.ok) {
        editorSettingsError = r.error ?? 'Restore failed'
        return
      }
      flashEditorStatus(`Editor settings restored on ${eng.name}`)
    } catch (err) {
      editorSettingsError = err instanceof Error ? err.message : String(err)
    } finally {
      editorSettingsBusy = false
    }
  }

  async function ctxRestoreKeybindings(): Promise<void> {
    if (!contextMenu || editorSettingsBusy) return
    const eng = contextMenu.engine
    closeContextMenu()
    editorSettingsBusy = true
    editorSettingsError = null
    try {
      const r = await window.api.engines.restoreKeybindings(eng.path)
      if (!r.ok) {
        editorSettingsError = r.error ?? 'Restore failed'
        return
      }
      flashEditorStatus(`Keybindings restored for ${eng.name}`)
    } catch (err) {
      editorSettingsError = err instanceof Error ? err.message : String(err)
    } finally {
      editorSettingsBusy = false
    }
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
      <div class="install-anchor">
        <button
          type="button"
          class="install-btn"
          onclick={() => void toggleInstallPicker()}
          aria-haspopup="menu"
          aria-expanded={installPickerOpen}
          title="Install an Unreal Engine version from your Epic library"
        >
          Install engine…
        </button>
        {#if installPickerOpen}
          <div class="install-picker" role="menu">
            {#if installerOwnedLoading}
              <div class="picker-state">Loading owned engines…</div>
            {:else if installerOwnedError}
              <div class="picker-state error">{installerOwnedError}</div>
            {:else if installablEngines.length === 0}
              <div class="picker-state empty">
                Every engine you own is already installed (or you haven't
                synced Epic yet — log in + sync first).
              </div>
            {:else}
              {#each installablEngines as sku (sku.appName)}
                <button
                  type="button"
                  class="picker-row"
                  role="menuitem"
                  onclick={() => pickEngineForInstall(sku)}
                >
                  <span class="picker-version">{sku.appName.replace(/^UE_/, 'UE ')}</span>
                  <span class="picker-build">{sku.buildVersion}</span>
                </button>
              {/each}
            {/if}
          </div>
        {/if}
      </div>
      <button type="button" onclick={() => enginesStore.rescan()} disabled={loading}>
        {loading ? 'Scanning…' : 'Rescan'}
      </button>
    </div>
  </header>

  {#if installerFlash}
    <div class="installer-flash">{installerFlash}</div>
  {/if}

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
    <div class="ctx-sep"></div>
    <button
      type="button"
      role="menuitem"
      onclick={ctxPreviewEditorSettings}
      disabled={editorSettingsBusy}
    >
      Preview editor settings master…
    </button>
    {#if cm.editorSettings?.hasBackup}
      <button
        type="button"
        role="menuitem"
        onclick={() => void ctxRestoreEditorSettings()}
        disabled={editorSettingsBusy}
      >
        Restore editor settings from baseline
      </button>
    {/if}
    <button
      type="button"
      role="menuitem"
      onclick={ctxPreviewKeybindings}
      disabled={editorSettingsBusy}
    >
      Preview keybindings master…
    </button>
    {#if cm.keybindings?.hasBackup}
      <button
        type="button"
        role="menuitem"
        onclick={() => void ctxRestoreKeybindings()}
        disabled={editorSettingsBusy}
      >
        Restore keybindings from baseline
      </button>
    {/if}
  </div>
{/if}

{#if editorSettingsStatus}
  <div class="status-toast" role="status">{editorSettingsStatus}</div>
{/if}
{#if editorSettingsError}
  <div class="error-toast" role="alert">
    <span>{editorSettingsError}</span>
    <button type="button" onclick={() => (editorSettingsError = null)}>×</button>
  </div>
{/if}

{#if previewingEngine}
  {@const eng = previewingEngine}
  {@const subject = previewSubject}
  <IniMasterPreviewDialog
    subjectLabel={subject === 'keybindings' ? 'Keybindings' : 'Editor settings'}
    targetLabel={subject === 'keybindings' ? `${eng.name} user config` : eng.name}
    previewFn={() =>
      subject === 'keybindings'
        ? window.api.engines.previewKeybindings(eng.path)
        : window.api.engines.previewEditorSettings(eng.path)}
    applyFn={() =>
      subject === 'keybindings'
        ? window.api.engines.applyKeybindings(eng.path)
        : window.api.engines.applyEditorSettings(eng.path)}
    onClose={() => (previewingEngine = null)}
    onApplied={(info) => {
      const summary = info.summary ?? ''
      const head =
        subject === 'keybindings'
          ? `Keybindings applied for ${eng.name}`
          : `Editor settings applied to ${eng.name}`
      flashEditorStatus(summary ? `${head} — ${summary}` : head)
    }}
  />
{/if}

{#if installerSelectedSku}
  {@const s = installerSelectedSku}
  <EngineDownloadDialog
    sku={s}
    onClose={() => (installerSelectedSku = null)}
    onConfirm={async (payload) => {
      const r = await window.api.engineDownloads.install({
        sku: {
          namespace: payload.sku.namespace,
          catalogItemId: payload.sku.catalogItemId,
          appName: payload.sku.appName,
          shortVersion: payload.sku.shortVersion
        },
        selectedTags: payload.selectedTags,
        installDir: payload.installDir
      })
      if (!r.ok) {
        flashInstaller(`Could not queue install: ${r.error}`)
        return
      }
      flashInstaller(
        `Queued install of ${payload.sku.appName} → ${payload.installDir}. Watch progress in Downloads.`
      )
      installerSelectedSku = null
      // The owned list now has one fewer "installable" engine — invalidate
      // it so the picker re-fetches next time it opens. We don't await this;
      // the next picker open will hit the stale data once and refresh.
      installerOwnedEngines = null
    }}
  />
{/if}

<svelte:window
  onclick={(e) => {
    if (!installPickerOpen) return
    const t = e.target as HTMLElement
    if (t.closest('.install-anchor')) return
    installPickerOpen = false
  }}
/>

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
  /* "Install engine…" + its dropdown picker. The anchor is positioned
     so the popover floats below the button without re-flowing the header
     row. */
  .install-anchor {
    position: relative;
    display: inline-flex;
  }
  .install-btn {
    margin-left: 0.5rem;
    background: linear-gradient(135deg, rgba(192, 132, 252, 0.18), rgba(244, 114, 182, 0.18));
    color: #f0e0ff;
    border: 1px solid #5a3e7a;
    border-radius: 4px;
    padding: 0.3rem 0.8rem;
    font-size: 0.75rem;
    font-family: inherit;
    cursor: pointer;
  }
  .install-btn:hover {
    background: linear-gradient(135deg, rgba(192, 132, 252, 0.28), rgba(244, 114, 182, 0.28));
    border-color: #c084fc;
    color: #fff;
  }
  .install-picker {
    position: absolute;
    top: calc(100% + 0.3rem);
    right: 0;
    z-index: 220;
    /* Wide enough to keep the longest "4.X.Y-12345678+++UE4+Release-…-Windows"
       build-version tag on a single line at the .picker-build font-size. */
    min-width: 420px;
    max-width: 480px;
    max-height: 360px;
    overflow-y: auto;
    overflow-x: hidden;
    background: #1a1a1a;
    border: 1px solid #3a3a3a;
    border-radius: 6px;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.6);
    padding: 0.25rem 0;
  }
  .picker-state {
    padding: 0.7rem 0.85rem;
    color: #888;
    font-size: 0.8rem;
    text-align: center;
  }
  .picker-state.error { color: #fca5a5; }
  .picker-state.empty { color: #b0b0b0; }
  .picker-row {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    width: 100%;
    gap: 0.15rem;
    padding: 0.5rem 0.85rem;
    background: transparent;
    border: none;
    color: #d0d0d0;
    font-family: inherit;
    text-align: left;
    cursor: pointer;
    min-width: 0;
  }
  .picker-row:hover { background: #2a213a; color: #fff; }
  .picker-version {
    font-size: 0.88rem;
    font-weight: 500;
  }
  .picker-build {
    font-size: 0.7rem;
    color: #888;
    font-family: ui-monospace, 'Cascadia Code', Consolas, monospace;
    /* Keep the long build-version tag on a single line — `.install-picker`
       is sized to fit; truncate with an ellipsis if it ever overflows. */
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 100%;
  }
  .installer-flash {
    background: #1f2a1f;
    border: 1px solid #2d4a2d;
    color: #c8f0c8;
    padding: 0.55rem 0.85rem;
    border-radius: 5px;
    font-size: 0.82rem;
    margin-bottom: 0.8rem;
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
  .ctx-menu button:hover:not(:disabled) {
    background: #2a2a2a;
    color: #fff;
  }
  .ctx-menu button:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }
  .ctx-sep {
    height: 1px;
    margin: 0.25rem 0;
    background: #2e2e2e;
  }
  .status-toast,
  .error-toast {
    position: fixed;
    bottom: 1.5rem;
    right: 1.5rem;
    z-index: 350;
    border-radius: 6px;
    padding: 0.55rem 0.9rem;
    font-size: 0.82rem;
    box-shadow: 0 4px 14px rgba(0, 0, 0, 0.55);
    max-width: 480px;
  }
  .status-toast {
    background: #1f1f1f;
    border: 1px solid #3a3a3a;
    color: #d0d0d0;
  }
  .error-toast {
    background: #3a1818;
    border: 1px solid #5a2727;
    color: #fca5a5;
    display: flex;
    align-items: flex-start;
    gap: 0.6rem;
  }
  .error-toast button {
    background: transparent;
    color: #fca5a5;
    border: none;
    font-size: 1rem;
    cursor: pointer;
    padding: 0;
    line-height: 1;
  }
  .error-toast button:hover {
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
