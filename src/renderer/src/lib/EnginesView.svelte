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

  /** Short version string ("5.5" / "4.27") of the user's default engine.
   *  Mirrored into the row UI as a `Default` badge; updated via the
   *  context-menu "Set as default engine" action. */
  let defaultEngineVersion = $state<string>('')

  async function loadDefaultEngineVersion(): Promise<void> {
    try {
      const s = await window.api.settings.get()
      defaultEngineVersion = s.defaultEngineVersion ?? ''
    } catch {
      // best-effort, the badge just stays hidden
    }
  }

  function shortVersionOf(engine: EngineInfo): string {
    // EngineInfo.version is the full "5.5.4" — short form is major.minor for
    // settings matching (`defaultEngineVersion` always carries that shape).
    return engine.version.split('.').slice(0, 2).join('.')
  }
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
  /** Last successful fetch time + whether it came from the persisted cache,
   *  so the picker can render a "Last refreshed N ago" footer + Refresh button. */
  let installerOwnedFetchedAt = $state<number | null>(null)
  let installerOwnedCached = $state(false)
  let installerOwnedStaleReason = $state<string | null>(null)
  /** The SKU the user picked → drives the EngineDownloadDialog. Null = dialog
   *  closed; non-null = dialog open against that SKU. */
  let installerSelectedSku = $state<EngineSku | null>(null)
  /** Toast surfaced once a confirm fires — task #15 hooks the real queue;
   *  for this commit we just show the user what would have been queued. */
  let installerFlash = $state<string | null>(null)
  /** Elevation prompt — set when the user picks a UAC-protected install
   *  directory but ReHoarder isn't running elevated. `payload` keeps the
   *  install args alive so we could re-issue them after the relaunch, but
   *  v1 just exits without resuming; the user re-opens the dialog post-
   *  relaunch and clicks Install again. */
  let elevationPrompt = $state<{
    installDir: string
    appName: string
  } | null>(null)
  let relaunchingElevated = $state(false)

  onMount(() => {
    void enginesStore.ensureLoaded()
    // Warm the "owned engines" list in the background so the Install picker
    // opens instantly the first time the user clicks it instead of stalling
    // 5–10s on `listOwnedAssets` + the bulk catalog metadata fetch. The
    // in-memory cache (installerOwnedEngines !== null) holds across re-mounts
    // and gets invalidated by `onInstalled` and by a successful install.
    void ensureInstallerOwnedLoaded()
    void loadDefaultEngineVersion()
  })

  // Re-pull settings on every settings save so the Default badge tracks the
  // SettingsView "default engine" input (and vice-versa).
  let firstDefaultTick = true
  $effect(() => {
    settingsVersion()
    if (firstDefaultTick) {
      firstDefaultTick = false
      return
    }
    void loadDefaultEngineVersion()
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
    installerOwnedStaleReason = null
    try {
      const r = await window.api.engineDownloads.listOwned({ forceRefresh: force })
      if (!r.ok) {
        installerOwnedError = r.error ?? 'Could not list owned engines'
        installerOwnedEngines = []
        return
      }
      installerOwnedEngines = r.engines ?? []
      installerOwnedFetchedAt = typeof r.fetchedAt === 'number' ? r.fetchedAt : null
      installerOwnedCached = r.cached === true
      installerOwnedStaleReason = r.staleReason ?? null
    } catch (err) {
      installerOwnedError = err instanceof Error ? err.message : String(err)
      installerOwnedEngines = []
    } finally {
      installerOwnedLoading = false
    }
  }

  function formatRelativeTime(ms: number): string {
    const diff = Date.now() - ms
    if (diff < 60 * 1000) return 'just now'
    if (diff < 60 * 60 * 1000) {
      const m = Math.round(diff / (60 * 1000))
      return `${m} min ago`
    }
    if (diff < 24 * 60 * 60 * 1000) {
      const h = Math.round(diff / (60 * 60 * 1000))
      return `${h} h ago`
    }
    const d = Math.round(diff / (24 * 60 * 60 * 1000))
    return `${d} d ago`
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
   * Viewport-clamp the engine context menu so a right-click near the bottom
   * doesn't crop the menu. Same pattern as in `ProjectsView.svelte` — measure
   * the menu after it binds, shift left/up if it overflows.
   */
  let contextMenuEl = $state<HTMLDivElement | null>(null)
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

  /** Engine-action quick-action stack, same shape as the one on Projects. */
  type EngineActionStatus = 'running' | 'ok' | 'error'
  interface EngineActionEntry {
    id: number
    engine: EngineInfo
    label: string
    status: EngineActionStatus
    message: string | null
  }
  let engineActions = $state<EngineActionEntry[]>([])
  let nextEngineActionId = 0
  function startEngineAction(engine: EngineInfo, label: string): number {
    const id = ++nextEngineActionId
    engineActions = [
      ...engineActions,
      { id, engine, label, status: 'running', message: null }
    ]
    return id
  }
  function endEngineAction(
    id: number,
    status: 'ok' | 'error',
    message: string
  ): void {
    engineActions = engineActions.map((a) =>
      a.id === id ? { ...a, status, message } : a
    )
  }
  function dismissEngineAction(id: number): void {
    engineActions = engineActions.filter((a) => a.id !== id)
  }

  /** Uninstall-engine confirm modal target; non-null = modal open. */
  let uninstallingEngine = $state<EngineInfo | null>(null)

  function formatBytes(n: number): string {
    if (n < 1024) return `${n} B`
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
    if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`
    return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`
  }

  async function ctxSetDefault(): Promise<void> {
    if (!contextMenu) return
    const eng = contextMenu.engine
    closeContextMenu()
    const id = startEngineAction(eng, 'Setting as default engine')
    try {
      const version = shortVersionOf(eng)
      const r = await window.api.engines.setDefaultVersion(version)
      if (!r.ok) {
        endEngineAction(id, 'error', r.error ?? 'Could not set default')
        return
      }
      defaultEngineVersion = version
      endEngineAction(id, 'ok', `${eng.name} is now the default engine.`)
    } catch (err) {
      endEngineAction(id, 'error', err instanceof Error ? err.message : String(err))
    }
  }

  async function ctxCreateShortcut(): Promise<void> {
    if (!contextMenu) return
    const eng = contextMenu.engine
    closeContextMenu()
    const id = startEngineAction(eng, 'Creating desktop shortcut')
    try {
      const r = await window.api.engines.createShortcut({
        engineRoot: eng.path,
        shortcutName: eng.name
      })
      if (!r.ok) {
        endEngineAction(id, 'error', r.error ?? 'Could not create shortcut')
        return
      }
      endEngineAction(id, 'ok', `Shortcut written to ${r.shortcutPath}.`)
    } catch (err) {
      endEngineAction(id, 'error', err instanceof Error ? err.message : String(err))
    }
  }

  function ctxUninstall(): void {
    if (!contextMenu) return
    const eng = contextMenu.engine
    closeContextMenu()
    uninstallingEngine = eng
  }

  async function confirmUninstall(): Promise<void> {
    const eng = uninstallingEngine
    if (!eng) return
    uninstallingEngine = null
    const id = startEngineAction(eng, 'Uninstalling engine')
    try {
      const r = await window.api.engines.uninstall(eng.path)
      if (!r.ok) {
        endEngineAction(id, 'error', r.error ?? 'Uninstall failed')
        return
      }
      const reg = r.registryDeregistered ? ' Registry deregistered.' : ''
      const pathDrop = r.enginePathRemoved ? ' Engine path pruned from settings.' : ''
      endEngineAction(
        id,
        'ok',
        `Removed ${formatBytes(r.bytesRemoved)} from disk.${reg}${pathDrop}`
      )
      // Clear "default engine" if we just uninstalled the one that was default.
      if (defaultEngineVersion === shortVersionOf(eng)) {
        defaultEngineVersion = ''
        void window.api.engines.setDefaultVersion('').catch(() => {})
      }
      void enginesStore.rescan()
    } catch (err) {
      endEngineAction(id, 'error', err instanceof Error ? err.message : String(err))
    }
  }

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
            {#if installerOwnedStaleReason}
              <div class="picker-footer stale">{installerOwnedStaleReason}</div>
            {/if}
            {#if installerOwnedEngines !== null && !installerOwnedLoading}
              <div class="picker-footer">
                <span class="picker-footer-info">
                  {#if installerOwnedFetchedAt}
                    {installerOwnedCached ? 'Cached' : 'Fetched'} {formatRelativeTime(installerOwnedFetchedAt)}
                  {:else}
                    From Epic
                  {/if}
                </span>
                <button
                  type="button"
                  class="picker-refresh"
                  onclick={(e) => {
                    e.stopPropagation()
                    void ensureInstallerOwnedLoaded(true)
                  }}
                  disabled={installerOwnedLoading}
                  title="Re-fetch the owned engines list from Epic (bypasses the cache)"
                >
                  Refresh
                </button>
              </div>
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
              {#if defaultEngineVersion && shortVersionOf(e) === defaultEngineVersion}
                <span class="default-pill" title="Used as the fallback when a project has no resolvable EngineAssociation">Default</span>
              {/if}
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
    bind:this={contextMenuEl}
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
    {#if shortVersionOf(cm.engine) === defaultEngineVersion}
      <button
        type="button"
        role="menuitem"
        onclick={() => {
          closeContextMenu()
          defaultEngineVersion = ''
          void window.api.engines.setDefaultVersion('').catch(() => {})
        }}
      >
        Clear default engine
      </button>
    {:else}
      <button type="button" role="menuitem" onclick={() => void ctxSetDefault()}>
        Set as default engine
      </button>
    {/if}
    <button type="button" role="menuitem" onclick={() => void ctxCreateShortcut()}>
      Create desktop shortcut
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
    <div class="ctx-sep"></div>
    <button type="button" role="menuitem" class="danger" onclick={ctxUninstall}>
      Uninstall engine…
    </button>
  </div>
{/if}

{#if uninstallingEngine}
  {@const ue = uninstallingEngine}
  <div
    class="confirm-backdrop"
    role="dialog"
    aria-modal="true"
    onmousedown={() => (uninstallingEngine = null)}
  >
    <div class="confirm-popup" onmousedown={(e) => e.stopPropagation()} role="document">
      <h3>Uninstall <code>{ue.name}</code>?</h3>
      <p class="confirm-text">
        This deletes <code>{ue.path}</code> recursively and removes its
        <code>HKCU\\Software\\Epic Games\\Unreal Engine\\Builds</code> registration on Windows.
        The action cannot be undone.
      </p>
      <p class="confirm-text small">
        Projects that referenced this engine via <code>EngineAssociation</code> will need
        to be retargeted to a different install.
      </p>
      <div class="confirm-actions">
        <button type="button" class="ghost" onclick={() => (uninstallingEngine = null)}>Cancel</button>
        <button type="button" class="danger" onclick={() => void confirmUninstall()}>
          Uninstall engine
        </button>
      </div>
    </div>
  </div>
{/if}

{#if engineActions.length > 0}
  <div class="engine-action-stack">
    {#each engineActions as a (a.id)}
      <div
        class="engine-action-banner"
        class:busy={a.status === 'running'}
        class:error={a.status === 'error'}
      >
        <div class="ea-text">
          <strong>{a.engine.name}</strong>
          <span class="ea-label">
            {#if a.status === 'running'}
              {a.label}… (this can take a while)
            {:else if a.status === 'error'}
              {a.label} failed — {a.message}
            {:else}
              {a.message}
            {/if}
          </span>
        </div>
        {#if a.status !== 'running'}
          <button
            type="button"
            class="ea-close"
            onclick={() => dismissEngineAction(a.id)}
            title="Dismiss"
          >×</button>
        {/if}
      </div>
    {/each}
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
      // Pre-flight: if the user picked a UAC-protected location and we're
      // not elevated, the chunk runner would EPERM on the first mkdir.
      // Surface a relaunch prompt instead of queueing a doomed download.
      try {
        const check = await window.api.engineDownloads.checkInstallDir(payload.installDir)
        if (check.ok && check.requiresAdmin && !check.isElevated) {
          elevationPrompt = {
            installDir: payload.installDir,
            appName: payload.sku.appName
          }
          return
        }
      } catch {
        // Check failure isn't fatal — proceed and let the runner surface
        // any real error in the Downloads row.
      }
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

{#if elevationPrompt}
  {@const p = elevationPrompt}
  <div
    class="confirm-backdrop elevation-prompt-backdrop"
    role="presentation"
    onclick={(e) => {
      if (
        (e.target as HTMLElement).classList.contains('confirm-backdrop') &&
        !relaunchingElevated
      ) {
        elevationPrompt = null
      }
    }}
  >
    <div class="confirm-popup" role="dialog" aria-modal="true" aria-label="Relaunch as administrator">
      <h3>This install location needs admin</h3>
      <p>
        <code>{p.installDir}</code> is a UAC-protected Windows location
        (Program Files, Windows, …). ReHoarder is running as a normal user,
        so the chunk writer would fail with <code>EPERM</code> on the first
        <code>mkdir</code>.
      </p>
      <p class="hint">
        Relaunch ReHoarder elevated to install <strong>{p.appName}</strong>
        there, or pick a user-writable folder (anywhere under your user
        profile, or a top-level folder on another drive you created
        yourself, works without admin). The downloads queue + library
        state persist across the relaunch — only the open dialog has to
        be reopened.
      </p>
      <div class="confirm-actions">
        <button
          type="button"
          class="ghost"
          disabled={relaunchingElevated}
          onclick={() => (elevationPrompt = null)}
        >
          Pick another folder
        </button>
        <button
          type="button"
          class="primary"
          disabled={relaunchingElevated}
          onclick={async () => {
            relaunchingElevated = true
            const r = await window.api.engineDownloads.relaunchElevated()
            if (!r.ok) {
              relaunchingElevated = false
              flashInstaller(`Could not relaunch elevated: ${r.error}`)
              elevationPrompt = null
            }
            // On success the app quits — no further UI work needed; if
            // for some reason the elevated process can't spawn, the catch
            // above shows the error.
          }}
        >
          {relaunchingElevated ? 'Relaunching…' : 'Relaunch as administrator'}
        </button>
      </div>
    </div>
  </div>
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
  .picker-footer {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 0.5rem;
    padding: 0.35rem 0.65rem;
    border-top: 1px solid #2a2a2a;
    margin-top: 0.2rem;
  }
  .picker-footer.stale {
    border-top: none;
    padding-top: 0.55rem;
    padding-bottom: 0;
    color: #fcd34d;
    font-size: 0.7rem;
    justify-content: flex-start;
  }
  .picker-footer-info {
    font-size: 0.7rem;
    color: #888;
  }
  .picker-refresh {
    background: transparent;
    color: #c084fc;
    border: 1px solid #3a3a3a;
    border-radius: 3px;
    padding: 0.15rem 0.55rem;
    font-size: 0.7rem;
    font-family: inherit;
    cursor: pointer;
  }
  .picker-refresh:hover:not(:disabled) {
    border-color: #c084fc;
    color: #fff;
  }
  .picker-refresh:disabled {
    opacity: 0.5;
    cursor: default;
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
  /* Confirm modal — same look used in EnginePluginsPanel + SettingsView so
     the visual language of "yes/no on a destructive bulk operation" stays
     consistent across the app. */
  .confirm-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.65);
    z-index: 290;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  /* Elevation prompt sits on top of an already-open EngineDownloadDialog
     (z-index 290 there too); bumping the backdrop ensures the relaunch
     buttons land above the dialog instead of being painted underneath. */
  .elevation-prompt-backdrop {
    z-index: 320;
  }
  .confirm-popup {
    width: min(540px, 92vw);
    background: #1a1a1a;
    border: 1px solid #333;
    border-radius: 10px;
    box-shadow: 0 12px 36px rgba(0, 0, 0, 0.6);
    padding: 1.1rem 1.25rem 1rem;
    display: flex;
    flex-direction: column;
    gap: 0.55rem;
  }
  .confirm-popup h3 {
    margin: 0 0 0.2rem;
    color: #fff;
    font-size: 1rem;
    text-transform: none;
    letter-spacing: 0;
  }
  .confirm-popup p {
    margin: 0;
    color: #c0c0c0;
    font-size: 0.85rem;
    line-height: 1.45;
  }
  .confirm-popup p.hint {
    color: #909090;
    font-size: 0.78rem;
  }
  .confirm-popup code {
    background: #2a2a2a;
    border: 1px solid #333;
    border-radius: 3px;
    padding: 0.05rem 0.35rem;
    font-family: ui-monospace, 'Cascadia Code', Consolas, monospace;
    font-size: 0.8em;
    word-break: break-all;
  }
  .confirm-actions {
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
    margin-top: 0.5rem;
  }
  .confirm-actions .ghost {
    background: transparent;
    color: #c0c0c0;
    border: 1px solid #444;
    border-radius: 5px;
    padding: 0.45rem 1rem;
    font-family: inherit;
    font-size: 0.82rem;
    cursor: pointer;
  }
  .confirm-actions .ghost:hover:not(:disabled) {
    color: #fff;
    border-color: #666;
  }
  .confirm-actions .ghost:disabled {
    opacity: 0.55;
    cursor: not-allowed;
  }
  .confirm-actions .primary {
    background: linear-gradient(135deg, #c084fc, #f472b6);
    color: #fff;
    border: none;
    border-radius: 5px;
    padding: 0.45rem 1.1rem;
    font-family: inherit;
    font-size: 0.85rem;
    cursor: pointer;
    font-weight: 500;
  }
  .confirm-actions .primary:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }
  .confirm-actions .danger {
    background: #5a2727;
    color: #fff;
    border: 1px solid #7a3737;
    border-radius: 5px;
    padding: 0.45rem 1.1rem;
    font-family: inherit;
    font-size: 0.85rem;
    cursor: pointer;
    font-weight: 500;
  }
  .confirm-actions .danger:hover {
    background: #7a3737;
    border-color: #9a4747;
  }
  .confirm-text {
    margin: 0 0 0.6rem;
    color: #d0d0d0;
    font-size: 0.85rem;
    line-height: 1.45;
  }
  .confirm-text.small {
    font-size: 0.78rem;
    color: #b0b0b0;
  }
  .ctx-menu button.danger {
    color: #fca5a5;
  }
  .ctx-menu button.danger:hover {
    background: #3a1f1f;
    color: #fff;
  }
  .default-pill {
    display: inline-block;
    margin-left: 0.4rem;
    padding: 0.05rem 0.45rem;
    background: #2a1f3a;
    color: #c084fc;
    border: 1px solid #4a3268;
    border-radius: 3px;
    font-size: 0.65rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    font-weight: 600;
    vertical-align: middle;
  }
  .engine-action-stack {
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
  .engine-action-banner {
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
  .engine-action-banner.busy {
    background: #1f1f2a;
    border-color: #3a3a55;
    color: #c0c0e0;
  }
  .engine-action-banner.error {
    background: #3a1f1f;
    border-color: #5a2727;
    color: #fca5a5;
  }
  .ea-text {
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
    flex: 1;
  }
  .ea-text strong {
    color: #fff;
    font-weight: 500;
    font-size: 0.82rem;
  }
  .ea-label {
    font-size: 0.75rem;
    opacity: 0.9;
  }
  .ea-close {
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
  .ea-close:hover {
    color: #fff;
    border-color: #666;
  }
</style>
