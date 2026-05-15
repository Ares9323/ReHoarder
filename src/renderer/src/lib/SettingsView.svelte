<script lang="ts">
  import { onMount } from 'svelte'
  import { bumpSettingsVersion } from '../stores/settings-events.svelte'
  import PresetChooserDialog from './PresetChooserDialog.svelte'
  import { enginesStore } from '../stores/engines.svelte'

  type ImageSize = 'small' | 'medium' | 'large'
  interface AppSettings {
    loginAtStartup: boolean
    checkVersionAtStartup: boolean
    autoDownloadAndInstallUpdates: boolean
    exitOnLaunchUnreal: boolean
    compilePluginsOnInstall: boolean
    deleteExtraVaultPlatforms: boolean
    skipCruftAtDownload: boolean
    focusFreebiesTabAtStartup: boolean
    cruftPatterns: string[]
    downloadThreads: number
    maxConcurrentDownloads: number
    imageSize: ImageSize
    projectPaths: string[]
    enginePaths: string[]
    vaultPaths: string[]
    separateProjectsByPath: boolean
    separateVaultsByPath: boolean
    showVaultThumbnails: boolean
    showProjectThumbnails: boolean
    pluginPresetGlobalPath: string
    pluginPresetPerEngine: Record<string, string>
    editorSettingsMasterPath: string
    editorKeyBindingsMasterPath: string
    gameLaunchParams: string[]
    ownedEnginesCacheTtlDays: number
  }

  let settings = $state<AppSettings | null>(null)
  // Path arrays are edited as multiline text in the UI, kept as text strings
  // so the user can type intermediate states (blank lines, partial paths).
  let projectPathsText = $state('')
  let enginePathsText = $state('')
  let vaultPathsText = $state('')
  let gameLaunchParamsText = $state('')
  let cruftPatternsText = $state('')

  let loading = $state(true)
  let saving = $state(false)
  let error = $state<string | null>(null)
  let savedFlash = $state(false)
  let dirty = $state(false)

  /** Bulk-apply state surfaced under the global preset field. */
  let applyAllBusy = $state(false)
  let applyAllSummary = $state<string | null>(null)
  let applyAllError = $state<string | null>(null)
  let presetChooserOpen = $state(false)
  let presetTemplateFlash = $state<string | null>(null)
  let editorSettingsChooserOpen = $state(false)
  let keybindingsChooserOpen = $state(false)
  /** Which "Apply to all" is awaiting confirmation; `null` means no modal up.
   *  These actions mutate every installed engine in one shot — a confirm step
   *  is the cheap way to avoid expensive misclicks. */
  let confirmingApply = $state<'plugin' | 'editor-settings' | 'keybindings' | null>(null)

  async function pickGlobalPreset(): Promise<void> {
    if (!settings) return
    const r = await window.api.engines.pickPresetFile()
    if (!r.ok || !r.path) return
    settings.pluginPresetGlobalPath = r.path
    await autoSave()
  }

  async function clearGlobalPreset(): Promise<void> {
    if (!settings) return
    settings.pluginPresetGlobalPath = ''
    await autoSave()
  }

  /** Open the global preset file with the system editor (whitelisted main-side). */
  async function openGlobalPresetFile(): Promise<void> {
    if (!settings?.pluginPresetGlobalPath) return
    const r = await window.api.engines.openPresetFile(settings.pluginPresetGlobalPath)
    if (!r.ok) error = r.error ?? 'Could not open preset file'
  }

  /**
   * Auto-save after a Pick / Create / Clear so the user doesn't need to
   * remember to hit Save afterwards. Wraps the existing save() path, which
   * already flushes every dirty field (textareas included) — same payload,
   * same IPC, just triggered for them.
   */
  async function autoSave(): Promise<void> {
    markDirty()
    await save()
  }

  /** Editor-settings master state — mirrors the pattern used for the plugin
   *  preset so the user can apply a curated BaseEditorPerProjectUserSettings.ini
   *  across every installed engine in one click. */
  let applyEditorSettingsBusy = $state(false)
  let applyEditorSettingsSummary = $state<string | null>(null)
  let applyEditorSettingsError = $state<string | null>(null)

  async function pickEditorSettingsMaster(): Promise<void> {
    if (!settings) return
    const r = await window.api.engines.pickMasterIniFile()
    if (!r.ok || !r.path) return
    settings.editorSettingsMasterPath = r.path
    await autoSave()
  }

  async function openEditorSettingsMaster(): Promise<void> {
    if (!settings?.editorSettingsMasterPath) return
    const r = await window.api.engines.openMasterIniFile(settings.editorSettingsMasterPath)
    if (!r.ok) applyEditorSettingsError = r.error ?? 'Could not open master file'
  }

  async function clearEditorSettingsMaster(): Promise<void> {
    if (!settings) return
    settings.editorSettingsMasterPath = ''
    await autoSave()
  }

  // -------- Keybindings master (mirrors editor-settings flow) --------

  let applyKeybindingsBusy = $state(false)
  let applyKeybindingsSummary = $state<string | null>(null)
  let applyKeybindingsError = $state<string | null>(null)

  async function pickKeybindingsMaster(): Promise<void> {
    if (!settings) return
    const r = await window.api.engines.pickKeybindingsFile()
    if (!r.ok || !r.path) return
    settings.editorKeyBindingsMasterPath = r.path
    await autoSave()
  }

  async function clearKeybindingsMaster(): Promise<void> {
    if (!settings) return
    settings.editorKeyBindingsMasterPath = ''
    await autoSave()
  }

  async function openKeybindingsMaster(): Promise<void> {
    if (!settings?.editorKeyBindingsMasterPath) return
    const r = await window.api.engines.openKeybindingsFile(settings.editorKeyBindingsMasterPath)
    if (!r.ok) applyKeybindingsError = r.error ?? 'Could not open keybindings master'
  }

  async function applyKeybindingsToAll(): Promise<void> {
    if (!settings || applyKeybindingsBusy) return
    if (!settings.editorKeyBindingsMasterPath?.trim()) {
      applyKeybindingsError = 'Set a keybindings master path first.'
      return
    }
    applyKeybindingsBusy = true
    applyKeybindingsError = null
    applyKeybindingsSummary = null
    try {
      const r = await window.api.engines.applyKeybindingsToAll()
      if (!r.ok) {
        applyKeybindingsError = r.error ?? 'Apply-to-all failed'
        return
      }
      const summaries = r.summaries ?? []
      const failures = r.failures ?? []
      const head = `Processed ${r.versionsProcessed ?? 0} unique engine version${r.versionsProcessed === 1 ? '' : 's'}.`
      if (failures.length === 0) {
        applyKeybindingsSummary =
          head + (summaries.length > 0 ? ` Examples: ${summaries[0].version} → ${summaries[0].summary}` : '')
      } else {
        applyKeybindingsSummary =
          head + ` ${failures.length} failure${failures.length === 1 ? '' : 's'}.`
        applyKeybindingsError = failures
          .slice(0, 6)
          .map((f) => `${f.version}: ${f.error}`)
          .join('\n')
        if (failures.length > 6) applyKeybindingsError += `\n…and ${failures.length - 6} more.`
      }
    } catch (err) {
      applyKeybindingsError = err instanceof Error ? err.message : String(err)
    } finally {
      applyKeybindingsBusy = false
    }
  }

  /** Dispatch the Apply-to-all worker for the kind currently in `confirmingApply`,
   *  then close the modal. Bound to the confirm dialog's primary button. */
  function runConfirmedApply(): void {
    const kind = confirmingApply
    confirmingApply = null
    if (kind === 'plugin') void applyPresetToAll()
    else if (kind === 'editor-settings') void applyEditorSettingsToAll()
    else if (kind === 'keybindings') void applyKeybindingsToAll()
  }

  async function applyEditorSettingsToAll(): Promise<void> {
    if (!settings || applyEditorSettingsBusy) return
    if (!settings.editorSettingsMasterPath?.trim()) {
      applyEditorSettingsError = 'Set a master ini path first.'
      return
    }
    applyEditorSettingsBusy = true
    applyEditorSettingsError = null
    applyEditorSettingsSummary = null
    try {
      const r = await window.api.engines.applyEditorSettingsToAll()
      if (!r.ok) {
        applyEditorSettingsError = r.error ?? 'Apply-to-all failed'
        return
      }
      const summaries = r.summaries ?? []
      const failures = r.failures ?? []
      const head = `Processed ${r.enginesProcessed ?? 0} engines.`
      if (failures.length === 0) {
        applyEditorSettingsSummary =
          head + (summaries.length > 0 ? ` Examples: ${summaries[0].engine} → ${summaries[0].summary}` : '')
      } else {
        applyEditorSettingsSummary =
          head + ` ${failures.length} failure${failures.length === 1 ? '' : 's'}.`
        applyEditorSettingsError = failures
          .slice(0, 6)
          .map((f) => `${f.engine}: ${f.error}`)
          .join('\n')
        if (failures.length > 6) applyEditorSettingsError += `\n…and ${failures.length - 6} more.`
      }
    } catch (err) {
      applyEditorSettingsError = err instanceof Error ? err.message : String(err)
    } finally {
      applyEditorSettingsBusy = false
    }
  }

  async function applyPresetToAll(): Promise<void> {
    if (!settings || applyAllBusy) return
    const presetPath = settings.pluginPresetGlobalPath?.trim()
    if (!presetPath) {
      applyAllError = 'Set a global preset path first.'
      return
    }
    applyAllBusy = true
    applyAllError = null
    applyAllSummary = null
    try {
      const r = await window.api.engines.applyPresetToAll(presetPath)
      if (!r.ok) {
        applyAllError = r.error ?? 'Apply-to-all failed'
        return
      }
      const failures = r.failures ?? []
      const head = `Processed ${r.enginesProcessed ?? 0} engines — ${r.pluginsChanged ?? 0} plugin write${r.pluginsChanged === 1 ? '' : 's'}.`
      if (failures.length === 0) {
        applyAllSummary = head
      } else {
        applyAllSummary = head + ` ${failures.length} failure${failures.length === 1 ? '' : 's'}.`
        applyAllError = failures
          .slice(0, 6)
          .map((f) => `${f.engine} / ${f.name}: ${f.error}`)
          .join('\n')
        if (failures.length > 6) applyAllError += `\n…and ${failures.length - 6} more.`
      }
    } catch (err) {
      applyAllError = err instanceof Error ? err.message : String(err)
    } finally {
      applyAllBusy = false
    }
  }

  // Updates pane state — populated lazily on mount. `updateState` walks:
  //   idle → checking → available | up-to-date | error
  //   available → downloading → ready (then user clicks restart)
  type UpdateState =
    | 'idle'
    | 'checking'
    | 'available'
    | 'up-to-date'
    | 'downloading'
    | 'ready'
    | 'error'
  let currentVersion = $state<string>('')
  let updateState = $state<UpdateState>('idle')
  let updateTargetVersion = $state<string | null>(null)
  let updateNotes = $state<string | null>(null)
  let updateError = $state<string | null>(null)
  let updateProgress = $state(0)

  async function checkForUpdates(): Promise<void> {
    updateState = 'checking'
    updateError = null
    try {
      const r = await window.api.updates.check()
      if (!r.ok) {
        updateState = 'error'
        updateError = r.error ?? 'Update check failed'
        return
      }
      if (r.currentVersion) currentVersion = r.currentVersion
      if (r.available) {
        updateState = 'available'
        updateTargetVersion = r.targetVersion ?? null
        updateNotes = r.notes ?? null
      } else {
        updateState = 'up-to-date'
      }
    } catch (err) {
      updateState = 'error'
      updateError = err instanceof Error ? err.message : String(err)
    }
  }

  async function downloadUpdate(): Promise<void> {
    updateState = 'downloading'
    updateProgress = 0
    updateError = null
    try {
      const r = await window.api.updates.download()
      if (!r.ok) {
        updateState = 'error'
        updateError = r.error ?? 'Download failed'
        return
      }
      updateState = 'ready'
    } catch (err) {
      updateState = 'error'
      updateError = err instanceof Error ? err.message : String(err)
    }
  }

  async function applyUpdate(): Promise<void> {
    try {
      const r = await window.api.updates.applyAndRestart()
      if (!r.ok) {
        updateState = 'error'
        updateError = r.error ?? 'Apply failed'
      }
      // On success the app is quitting — no UI to update.
    } catch (err) {
      updateState = 'error'
      updateError = err instanceof Error ? err.message : String(err)
    }
  }

  function fromArray(arr: string[]): string {
    return arr.join('\n')
  }
  function toArray(text: string): string[] {
    return text
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
  }
  function fromArgs(arr: string[]): string {
    return arr.join(' ')
  }
  function toArgs(text: string): string[] {
    return text
      .split(/\s+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
  }

  async function load(): Promise<void> {
    loading = true
    error = null
    try {
      const s = await window.api.settings.get()
      settings = s
      projectPathsText = fromArray(s.projectPaths)
      enginePathsText = fromArray(s.enginePaths)
      vaultPathsText = fromArray(s.vaultPaths)
      gameLaunchParamsText = fromArgs(s.gameLaunchParams)
      cruftPatternsText = fromArray(s.cruftPatterns)
      dirty = false
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
    } finally {
      loading = false
    }
  }

  async function save(): Promise<void> {
    if (!settings) return
    saving = true
    error = null
    try {
      const payload: AppSettings = {
        ...settings,
        projectPaths: toArray(projectPathsText),
        enginePaths: toArray(enginePathsText),
        vaultPaths: toArray(vaultPathsText),
        gameLaunchParams: toArgs(gameLaunchParamsText),
        cruftPatterns: toArray(cruftPatternsText),
        // `$state` wraps nested objects in Proxies; Electron's IPC uses the
        // structured-clone algorithm which throws on Proxy values. Snapshot
        // the Record into a plain object before the round-trip.
        pluginPresetPerEngine: $state.snapshot(settings.pluginPresetPerEngine)
      }
      const saved = await window.api.settings.set(payload)
      settings = saved
      projectPathsText = fromArray(saved.projectPaths)
      enginePathsText = fromArray(saved.enginePaths)
      vaultPathsText = fromArray(saved.vaultPaths)
      gameLaunchParamsText = fromArgs(saved.gameLaunchParams)
      cruftPatternsText = fromArray(saved.cruftPatterns)
      dirty = false
      savedFlash = true
      window.setTimeout(() => (savedFlash = false), 1500)
      bumpSettingsVersion()
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
    } finally {
      saving = false
    }
  }

  function markDirty(): void {
    dirty = true
  }

  onMount(async () => {
    await load()
    // Background-load engine count so the "Apply to all" confirm can name how
    // many installs will be patched. Best-effort: failing scan just hides the
    // count, the confirm copy still makes sense.
    void enginesStore.ensureLoaded()
    try {
      currentVersion = await window.api.updates.currentVersion()
    } catch {
      // best effort: leave version blank
    }
    // If main has already auto-checked and found an update, reflect that here
    // so the banner shows without forcing the user to click "Check for updates".
    try {
      const pending = await window.api.updates.getPendingState()
      if (pending.ok && pending.available && updateState === 'idle') {
        updateState = 'available'
        updateTargetVersion = pending.targetVersion ?? null
        updateNotes = pending.notes ?? null
      }
    } catch {
      // ignore — pending-state probe is best-effort
    }
  })

  // Subscribe to download progress events. Returned unsubscribe is tracked
  // by `$effect` so it cleans up on component unmount.
  $effect(() => {
    const unsub = window.api.updates.onDownloadProgress((perc) => {
      updateProgress = perc
    })
    return unsub
  })

  // Listen for the startup auto-check event so a SettingsView mounted *while*
  // main is still checking still picks up the result.
  $effect(() => {
    const unsub = window.api.updates.onAvailable((info) => {
      if (!info.available) return
      // Don't clobber a download-in-progress state if the user already started
      // one — the banner is meaningful only when we're idle.
      if (updateState !== 'idle' && updateState !== 'up-to-date' && updateState !== 'error') return
      updateState = 'available'
      updateTargetVersion = info.targetVersion ?? null
      updateNotes = info.notes ?? null
    })
    return unsub
  })

  // Ctrl+S / Cmd+S — common reflex for "save" forms. Only fires while the
  // panel is mounted (effect cleanup removes the listener on unmount). We
  // call `preventDefault` so the browser's own Save dialog doesn't pop up.
  $effect(() => {
    const onKey = (e: globalThis.KeyboardEvent): void => {
      const isSave = (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 's'
      if (!isSave) return
      e.preventDefault()
      if (!dirty || saving || loading) return
      void save()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })
</script>

<section>
  <header class="bar">
    <h2>Settings</h2>
    <div class="status">
      {#if savedFlash}<span class="ok">Saved ✓</span>{/if}
      {#if error}<span class="err">{error}</span>{/if}
      <button type="button" class="primary" onclick={save} disabled={!dirty || saving || loading}>
        {saving ? 'Saving…' : 'Save'}
      </button>
    </div>
  </header>

  {#if loading || !settings}
    <p class="loading">Loading settings…</p>
  {:else}
    <div class="grid">
      <div class="group">
        <h3>Startup &amp; behavior</h3>
        <label>
          <input
            type="checkbox"
            bind:checked={settings.loginAtStartup}
            onchange={markDirty}
          />
          Login to Epic at startup
        </label>
        <label>
          <input
            type="checkbox"
            bind:checked={settings.checkVersionAtStartup}
            onchange={markDirty}
          />
          Check version at startup
          <span class="hint">(asks GitHub Releases for a newer build a moment after launch)</span>
        </label>
        <label class:disabled-soft={!settings.checkVersionAtStartup}>
          <input
            type="checkbox"
            bind:checked={settings.autoDownloadAndInstallUpdates}
            onchange={markDirty}
            disabled={!settings.checkVersionAtStartup}
          />
          Automatically download and install updates
          <span class="hint">(when a newer build is found at startup, install it and restart silently)</span>
        </label>
        <label>
          <input
            type="checkbox"
            bind:checked={settings.exitOnLaunchUnreal}
            onchange={markDirty}
          />
          Exit ReHoarder when launching Unreal
          <span class="hint">(quits the app after the editor or Run-game spawns)</span>
        </label>
        <label>
          <input
            type="checkbox"
            bind:checked={settings.focusFreebiesTabAtStartup}
            onchange={markDirty}
          />
          Focus Freebies tab at startup if unclaimed
          <span class="hint">(opens the Freebies tab on launch when this month's free assets haven't been claimed)</span>
        </label>

        <div class="sub-divider"></div>
        <p class="explain">
          Current version: <code>{currentVersion || '—'}</code>
          {#if updateState === 'up-to-date'}<span class="ok">· up to date</span>{/if}
          {#if updateState === 'available' && updateTargetVersion}<span class="up">· {updateTargetVersion} available</span>{/if}
          {#if updateState === 'ready'}<span class="up">· update ready</span>{/if}
        </p>
        <div class="updates-row">
          {#if updateState === 'idle' || updateState === 'up-to-date' || updateState === 'error'}
            <button type="button" class="ghost" onclick={checkForUpdates}>
              Check for updates
            </button>
          {:else if updateState === 'checking'}
            <button type="button" class="ghost" disabled>Checking…</button>
          {:else if updateState === 'available'}
            <button type="button" class="primary" onclick={downloadUpdate}>
              Download {updateTargetVersion ?? 'update'}
            </button>
            <button type="button" class="ghost" onclick={checkForUpdates}>Re-check</button>
          {:else if updateState === 'downloading'}
            <button type="button" class="ghost" disabled>
              Downloading… {Math.round(updateProgress)}%
            </button>
          {:else if updateState === 'ready'}
            <button type="button" class="primary" onclick={applyUpdate}>
              Install &amp; restart
            </button>
          {/if}
        </div>
        {#if updateState === 'downloading'}
          <div class="progress"><div class="progress-fill" style:width="{updateProgress}%"></div></div>
        {/if}
        {#if updateError}
          <span class="hint hint-error">{updateError}</span>
        {/if}
        {#if updateNotes && updateState === 'available'}
          <details class="notes">
            <summary>Release notes</summary>
            <pre>{updateNotes}</pre>
          </details>
        {/if}
      </div>

      <div class="group">
        <h3>Downloads</h3>
        <label class="row">
          <span class="lbl">Parallel downloads</span>
          <input
            type="number"
            min="1"
            max="8"
            step="1"
            class="num-input"
            bind:value={settings.maxConcurrentDownloads}
            onchange={markDirty}
          />
          <span class="hint">(1–8 assets downloading from the queue at the same time)</span>
        </label>
        <label class="row">
          <span class="lbl">Download threads</span>
          <input
            type="number"
            min="1"
            max="64"
            step="1"
            class="num-input"
            bind:value={settings.downloadThreads}
            onchange={markDirty}
          />
          <span class="hint">(1–64, chunk-level worker pool within one asset)</span>
        </label>
        <label class="row">
          <span class="lbl">Owned engines cache</span>
          <input
            type="number"
            min="0"
            max="30"
            step="1"
            class="num-input"
            bind:value={settings.ownedEnginesCacheTtlDays}
            onchange={markDirty}
          />
          <span class="hint">
            (days the "Install engine…" picker keeps the Epic library list cached on
            disk; 0 = always refresh. Refresh button in the picker bypasses this.)
          </span>
        </label>
        <label>
          <input
            type="checkbox"
            bind:checked={settings.compilePluginsOnInstall}
            onchange={markDirty}
          />
          Compile plugins when installing
          <span class="hint">(invokes <code>RunUAT BuildPlugin</code>; default ON on Linux)</span>
        </label>
        <label>
          <input
            type="checkbox"
            bind:checked={settings.deleteExtraVaultPlatforms}
            onchange={markDirty}
          />
          Skip non-current-platform binaries
          <span class="hint">(don't download <code>Binaries/Mac</code>, <code>Binaries/Linux</code>, etc.)</span>
        </label>
        <label>
          <input
            type="checkbox"
            bind:checked={settings.skipCruftAtDownload}
            onchange={markDirty}
          />
          Skip cruft at download
          <span class="hint">(omit docs, vendor PDFs, DCC source files — built-in list + your extras)</span>
        </label>
        <label class="stack">
          <span class="lbl-block">Extra cruft patterns</span>
          <textarea
            bind:value={cruftPatternsText}
            oninput={markDirty}
            placeholder={'one glob per line — e.g.\n**/*.fbx\nSamples/**'}
            rows="4"
            spellcheck="false"
          ></textarea>
          <span
            class="hint hint-help"
            title={'Minimal glob syntax:\n  *  → zero or more characters (no slash)\n  ?  → one character (no slash)\n  ** → zero or more path segments (slashes included)\n  Paths are case-insensitive and accept both / and \\\n\nExamples:\n  **/*.fbx           → every .fbx anywhere\n  Samples/**         → the whole Samples/ folder at the root\n  **/Documentation/**→ Documentation folder at any depth\n  Content/*.uasset   → only .uasset directly inside Content (not Content/Sub/)'}
          >Glob syntax: <code>*</code>, <code>?</code>, <code>**</code> — hover for details. Applied on top of the built-in cruft list.</span>
        </label>
        <label class="row">
          <span class="lbl">Image size</span>
          <select bind:value={settings.imageSize} onchange={markDirty}>
            <option value="small">Small</option>
            <option value="medium">Medium</option>
            <option value="large">Large</option>
          </select>
          <span class="hint">(thumbnail / cover size used across asset grids)</span>
        </label>
      </div>

      <div class="group full">
        <h3>Engines</h3>
        <label class="stack">
          <span class="lbl-block">Global plugin preset</span>
          <div class="preset-input">
            <input
              type="text"
              class="text-input"
              bind:value={settings.pluginPresetGlobalPath}
              oninput={markDirty}
              placeholder={"Path to a JSON file with { plugins: [{ name, enabledByDefault, installed }] }"}
              spellcheck="false"
            />
            {#if settings.pluginPresetGlobalPath}
              <button type="button" class="ghost" onclick={() => void openGlobalPresetFile()}>Open</button>
            {/if}
            <button
              type="button"
              class="ghost"
              onclick={() => (presetChooserOpen = true)}
              title="Pick a built-in template (Empty, Ares recommended, …) and use it as the global preset"
            >
              Use template…
            </button>
            <button type="button" class="ghost" onclick={() => void pickGlobalPreset()}>Pick…</button>
            {#if settings.pluginPresetGlobalPath}
              <button type="button" class="ghost" onclick={() => void clearGlobalPreset()}>Clear</button>
            {/if}
            <button
              type="button"
              class="primary primary-inline"
              onclick={() => (confirmingApply = 'plugin')}
              disabled={applyAllBusy || !settings.pluginPresetGlobalPath?.trim()}
              title="Apply this preset to every engine without a per-engine override"
            >
              {applyAllBusy ? 'Applying…' : 'Apply to all'}
            </button>
          </div>
          <span class="hint">
            Fallback applied to engines without a per-engine override (set those from the
            Engines tab). Each engine can point at a different file.
          </span>
          {#if presetTemplateFlash}
            <span class="apply-all-ok">{presetTemplateFlash}</span>
          {/if}
          {#if applyAllSummary}
            <span class="apply-all-ok">{applyAllSummary}</span>
          {/if}
          {#if applyAllError}
            <pre class="apply-all-error">{applyAllError}</pre>
          {/if}
        </label>

        <label class="stack">
          <span class="lbl-block">Editor settings master ini</span>
          <div class="preset-input">
            <input
              type="text"
              class="text-input"
              bind:value={settings.editorSettingsMasterPath}
              oninput={markDirty}
              placeholder={"Path to a master BaseEditorPerProjectUserSettings.ini"}
              spellcheck="false"
            />
            {#if settings.editorSettingsMasterPath}
              <button type="button" class="ghost" onclick={() => void openEditorSettingsMaster()}>Open</button>
            {/if}
            <button
              type="button"
              class="ghost"
              onclick={() => (editorSettingsChooserOpen = true)}
              title="Pick a built-in template (Empty, Annotated starter, Ares Recommended, …) and use it as the master"
            >
              Use template…
            </button>
            <button type="button" class="ghost" onclick={() => void pickEditorSettingsMaster()}>Pick…</button>
            {#if settings.editorSettingsMasterPath}
              <button type="button" class="ghost" onclick={() => void clearEditorSettingsMaster()}>Clear</button>
            {/if}
            <button
              type="button"
              class="primary primary-inline"
              onclick={() => (confirmingApply = 'editor-settings')}
              disabled={applyEditorSettingsBusy || !settings.editorSettingsMasterPath?.trim()}
              title="Apply this master to every engine's BaseEditorPerProjectUserSettings.ini"
            >
              {applyEditorSettingsBusy ? 'Applying…' : 'Apply to all'}
            </button>
          </div>
          <span class="hint">
            Merge sections, scalars and array values from this master into every
            <code>Engine/Config/BaseEditorPerProjectUserSettings.ini</code>. First Apply on a clean
            engine captures the original as <code>.bak</code> for Restore.
          </span>
          {#if applyEditorSettingsSummary}
            <span class="apply-all-ok">{applyEditorSettingsSummary}</span>
          {/if}
          {#if applyEditorSettingsError}
            <pre class="apply-all-error">{applyEditorSettingsError}</pre>
          {/if}
        </label>

        <label class="stack">
          <span class="lbl-block">Editor keybindings master</span>
          <div class="preset-input">
            <input
              type="text"
              class="text-input"
              bind:value={settings.editorKeyBindingsMasterPath}
              oninput={markDirty}
              placeholder={"Path to a master EditorKeyBindings.ini"}
              spellcheck="false"
            />
            {#if settings.editorKeyBindingsMasterPath}
              <button type="button" class="ghost" onclick={() => void openKeybindingsMaster()}>Open</button>
            {/if}
            <button
              type="button"
              class="ghost"
              onclick={() => (keybindingsChooserOpen = true)}
              title="Pick a built-in template (Empty, Annotated starter, Ares Recommended, …) and use it as the master"
            >
              Use template…
            </button>
            <button type="button" class="ghost" onclick={() => void pickKeybindingsMaster()}>Pick…</button>
            {#if settings.editorKeyBindingsMasterPath}
              <button type="button" class="ghost" onclick={() => void clearKeybindingsMaster()}>Clear</button>
            {/if}
            <button
              type="button"
              class="primary primary-inline"
              onclick={() => (confirmingApply = 'keybindings')}
              disabled={applyKeybindingsBusy || !settings.editorKeyBindingsMasterPath?.trim()}
              title="Apply this master to every engine version's per-user EditorKeyBindings.ini"
            >
              {applyKeybindingsBusy ? 'Applying…' : 'Apply to all'}
            </button>
          </div>
          <span class="hint">
            Merge into each engine's per-user keybindings file at
            <code>%LOCALAPPDATA%\\UnrealEngine\\&lt;ver&gt;\\Saved\\Config\\WindowsEditor\\EditorKeyBindings.ini</code>
            (one file per engine version). First Apply captures the user's original as <code>.bak</code>.
          </span>
          {#if applyKeybindingsSummary}
            <span class="apply-all-ok">{applyKeybindingsSummary}</span>
          {/if}
          {#if applyKeybindingsError}
            <pre class="apply-all-error">{applyKeybindingsError}</pre>
          {/if}
        </label>
      </div>

      <div class="group full">
        <h3>Vault paths</h3>
        <p class="explain">
          Where downloaded assets are written. The first writable path wins; the others are scanned read-only.
        </p>
        <textarea
          rows="3"
          bind:value={vaultPathsText}
          oninput={markDirty}
          spellcheck="false"
        ></textarea>
        <label>
          <input
            type="checkbox"
            bind:checked={settings.separateVaultsByPath}
            onchange={markDirty}
          />
          Separate by path
          <span class="hint">(render one table per root path on the Vault tab)</span>
        </label>
        <label>
          <input
            type="checkbox"
            bind:checked={settings.showVaultThumbnails}
            onchange={markDirty}
          />
          Show thumbnails
          <span class="hint">(display the asset image next to each entry — slightly heavier on big vaults)</span>
        </label>
      </div>

      <div class="group full">
        <h3>Project paths</h3>
        <p class="explain">
          Folders scanned recursively for <code>*.uproject</code>. One path per line.
        </p>
        <textarea
          rows="3"
          bind:value={projectPathsText}
          oninput={markDirty}
          spellcheck="false"
        ></textarea>
        <label>
          <input
            type="checkbox"
            bind:checked={settings.separateProjectsByPath}
            onchange={markDirty}
          />
          Separate by path
          <span class="hint">(render one table per root path on the Projects tab)</span>
        </label>
        <label>
          <input
            type="checkbox"
            bind:checked={settings.showProjectThumbnails}
            onchange={markDirty}
          />
          Show thumbnails
          <span class="hint">
            (display the source-asset image next to each project; only available for projects created with
            <em>Create project</em> from this app)
          </span>
        </label>
        <label class="stack">
          <span class="lbl-block">Run params</span>
          <input
            type="text"
            class="text-input"
            placeholder="-log -windowed -ResX=1280 -ResY=720"
            bind:value={gameLaunchParamsText}
            oninput={markDirty}
            spellcheck="false"
          />
          <span class="hint">
            Extra args appended after <code>-game</code> when clicking <strong>Run</strong>.
            Space-separated. <code>-game</code> is added automatically.
          </span>
        </label>
      </div>

      <div class="group full">
        <h3>Unreal Engine paths</h3>
        <p class="explain">
          Folders scanned for <code>UE_*/Engine/Build/Build.version</code>. One per line.
        </p>
        <textarea
          rows="3"
          bind:value={enginePathsText}
          oninput={markDirty}
          spellcheck="false"
        ></textarea>
      </div>
    </div>
  {/if}
</section>

{#if presetChooserOpen}
  <PresetChooserDialog
    title="Choose a plugin preset template"
    subtitle="Selecting one overwrites the default preset file and sets it as the global path."
    unitLabel="plugin"
    listFn={() => window.api.engines.listPluginPresetLibrary()}
    useFn={(id) => window.api.engines.usePluginPresetFromLibrary(id)}
    onClose={() => (presetChooserOpen = false)}
    onApplied={async ({ path, label }) => {
      if (settings) {
        settings.pluginPresetGlobalPath = path
        // Persist the path the IPC just stamped — keeps the input bound and
        // ensures a refresh elsewhere picks it up. autoSave will re-save the
        // identical value, which is fine.
        await autoSave()
      }
      presetTemplateFlash = `Activated template "${label}" → ${path}`
      // Auto-clear the flash after a few seconds so it doesn't linger.
      setTimeout(() => {
        presetTemplateFlash = null
      }, 4000)
    }}
  />
{/if}

{#if editorSettingsChooserOpen}
  <PresetChooserDialog
    title="Choose an editor settings master template"
    subtitle="Selecting one overwrites the master ini and sets it as the active editor-settings master."
    unitLabel="override"
    listFn={() => window.api.engines.listEditorSettingsPresetLibrary()}
    useFn={(id) => window.api.engines.useEditorSettingsPresetFromLibrary(id)}
    onClose={() => (editorSettingsChooserOpen = false)}
    onApplied={async ({ path, label }) => {
      if (settings) {
        settings.editorSettingsMasterPath = path
        await autoSave()
      }
      applyEditorSettingsSummary = `Activated template "${label}" → ${path}`
      setTimeout(() => {
        applyEditorSettingsSummary = null
      }, 4000)
    }}
  />
{/if}

{#if keybindingsChooserOpen}
  <PresetChooserDialog
    title="Choose a keybindings master template"
    subtitle="Selecting one overwrites the master ini and sets it as the active keybindings master."
    unitLabel="chord rule"
    listFn={() => window.api.engines.listKeybindingsPresetLibrary()}
    useFn={(id) => window.api.engines.useKeybindingsPresetFromLibrary(id)}
    onClose={() => (keybindingsChooserOpen = false)}
    onApplied={async ({ path, label }) => {
      if (settings) {
        settings.editorKeyBindingsMasterPath = path
        await autoSave()
      }
      applyKeybindingsSummary = `Activated template "${label}" → ${path}`
      setTimeout(() => {
        applyKeybindingsSummary = null
      }, 4000)
    }}
  />
{/if}

{#if confirmingApply}
  {@const engineCount = enginesStore.engines.length}
  {@const versionCount = new Set(
    enginesStore.engines.map((e) => {
      const parts = e.version.split('.').filter((s) => s.length > 0)
      return parts.length >= 2 ? `${parts[0]}.${parts[1]}` : parts[0] ?? e.version
    })
  ).size}
  {@const kind = confirmingApply}
  <div
    class="confirm-backdrop"
    role="presentation"
    onclick={(e) => {
      if ((e.target as HTMLElement).classList.contains('confirm-backdrop')) {
        confirmingApply = null
      }
    }}
  >
    <div class="confirm-popup" role="dialog" aria-modal="true" aria-label="Confirm apply to all">
      {#if kind === 'plugin'}
        <h3>Apply plugin preset to all engines?</h3>
        <p>
          This will toggle plugin <code>EnabledByDefault</code> / <code>Installed</code> flags on
          <strong>{engineCount || 'every configured'}</strong> engine{engineCount === 1 ? '' : 's'}
          to match the preset at
          <code>{settings?.pluginPresetGlobalPath}</code>.
        </p>
        <p class="hint">
          Engines with a per-engine preset override use that file instead. A per-file
          <code>.bak</code> is captured before each write, and the per-engine baseline
          taken on the first toggle is preserved so Restore still works.
        </p>
      {:else if kind === 'editor-settings'}
        <h3>Apply editor settings master to all engines?</h3>
        <p>
          This will merge the master at <code>{settings?.editorSettingsMasterPath}</code>
          into <strong>{engineCount || 'every configured'}</strong> engine{engineCount === 1 ? '' : 's'}'
          <code>BaseEditorPerProjectUserSettings.ini</code>.
        </p>
        <p class="hint">
          First Apply on a clean engine captures the original as <code>.bak</code>; subsequent
          Applies re-merge against the same baseline. Use Restore from baseline (Engines
          tab → right-click) to revert.
        </p>
      {:else if kind === 'keybindings'}
        <h3>Apply keybindings master to all engine versions?</h3>
        <p>
          This will merge the master at <code>{settings?.editorKeyBindingsMasterPath}</code>
          into the per-user <code>EditorKeyBindings.ini</code> for
          <strong>{versionCount || 'every detected'}</strong> unique engine version{versionCount === 1 ? '' : 's'}.
        </p>
        <p class="hint">
          Multiple engine installs of the same version share one keybindings file under
          <code>%LOCALAPPDATA%\\UnrealEngine\\&lt;ver&gt;\\…</code> — each version is patched once.
          The user's original is captured as <code>.bak</code> on the first Apply.
        </p>
      {/if}
      <div class="confirm-actions">
        <button type="button" class="ghost" onclick={() => (confirmingApply = null)}>
          Cancel
        </button>
        <button type="button" class="primary" onclick={runConfirmedApply}>
          Apply
        </button>
      </div>
    </div>
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
    align-items: center;
    margin-bottom: 1rem;
    gap: 1rem;
    flex-wrap: wrap;
  }
  h2 {
    margin: 0;
    font-size: 1.15rem;
    color: #fff;
  }
  .status {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    font-size: 0.85rem;
  }
  .ok {
    color: #86efac;
  }
  .err {
    color: #fca5a5;
    max-width: 400px;
  }
  .primary {
    background: linear-gradient(135deg, #c084fc, #f472b6);
    color: #fff;
    border: none;
    border-radius: 5px;
    padding: 0.45rem 1.1rem;
    font-size: 0.85rem;
    font-family: inherit;
    cursor: pointer;
    font-weight: 500;
  }
  /* Compact variant for primary buttons that sit inline next to .ghost ones
     (e.g. the "Apply to all" buttons in the Engines section, lined up after
     Clear). Keeps the gradient/typography of .primary but matches the size
     of the surrounding ghost buttons. */
  .primary-inline {
    padding: 0.4rem 0.9rem;
    font-size: 0.82rem;
    white-space: nowrap;
  }
  /* Subtle divider used to visually separate sub-sections within a single
     `.group` panel (e.g. About+updates inside Startup & behavior). */
  .sub-divider {
    height: 1px;
    background: #2c2c2c;
    margin: 0.4rem 0 0.2rem;
  }
  /* Confirm modal for Apply-to-all actions. Mirrors the look used in
     EnginePluginsPanel's uninstall / restore-baseline confirms so the app
     speaks one visual language about destructive bulk operations. */
  .confirm-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.65);
    z-index: 290;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .confirm-popup {
    width: min(520px, 92vw);
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
  .primary:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }
  .loading {
    color: #888;
    text-align: center;
    padding: 2rem;
  }
  .grid {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 1rem;
  }
  .group {
    background: #242424;
    border: 1px solid #333;
    border-radius: 8px;
    padding: 1rem 1.1rem;
    display: flex;
    flex-direction: column;
    gap: 0.7rem;
  }
  .group.full {
    grid-column: 1 / -1;
  }
  h3 {
    margin: 0 0 0.3rem;
    font-size: 0.78rem;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: #c084fc;
    font-weight: 600;
  }
  label {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    color: #d0d0d0;
    font-size: 0.85rem;
    cursor: pointer;
    flex-wrap: wrap;
  }
  label.row {
    display: flex;
  }
  .lbl {
    color: #b0b0b0;
    min-width: 140px;
  }
  .hint {
    color: #777;
    font-size: 0.74rem;
  }
  .hint code {
    color: #a0a0a0;
    font-size: 0.72rem;
  }
  .hint-error {
    color: #fbbf24;
  }
  .hint-help {
    cursor: help;
    text-decoration: underline dotted #555 1px;
    text-underline-offset: 2px;
  }
  .updates-row {
    display: flex;
    gap: 0.5rem;
    flex-wrap: wrap;
  }
  .ghost {
    background: transparent;
    border: 1px solid #444;
    color: #c0c0c0;
    border-radius: 5px;
    padding: 0.4rem 0.9rem;
    font-family: inherit;
    font-size: 0.82rem;
    cursor: pointer;
  }
  .ghost:hover:not(:disabled) {
    color: #fff;
    border-color: #666;
  }
  .ghost:disabled {
    opacity: 0.55;
    cursor: not-allowed;
  }
  .progress {
    height: 6px;
    background: #2a2a2a;
    border-radius: 3px;
    overflow: hidden;
  }
  .progress-fill {
    height: 100%;
    background: linear-gradient(90deg, #c084fc, #f472b6);
    transition: width 0.2s;
  }
  .notes summary {
    cursor: pointer;
    color: #b0b0b0;
    font-size: 0.78rem;
  }
  .notes pre {
    color: #d0d0d0;
    background: #1a1a1a;
    border: 1px solid #2a2a2a;
    border-radius: 4px;
    padding: 0.55rem 0.7rem;
    font-size: 0.75rem;
    white-space: pre-wrap;
    max-height: 220px;
    overflow: auto;
  }
  .up {
    color: #fbbf24;
    font-size: 0.75rem;
  }
  .disabled-soft {
    opacity: 0.78;
  }
  input[type='checkbox'] {
    accent-color: #c084fc;
    width: 1rem;
    height: 1rem;
  }
  .num-input {
    width: 70px;
    background: #1a1a1a;
    border: 1px solid #3a3a3a;
    border-radius: 4px;
    color: #e0e0e0;
    padding: 0.25rem 0.45rem;
    font-family: inherit;
    font-size: 0.85rem;
  }
  .text-input {
    background: #1a1a1a;
    border: 1px solid #3a3a3a;
    border-radius: 4px;
    color: #e0e0e0;
    padding: 0.3rem 0.55rem;
    font-family: ui-monospace, 'Cascadia Code', Consolas, monospace;
    font-size: 0.8rem;
    box-sizing: border-box;
    width: 100%;
  }
  .text-input::placeholder {
    color: #555;
  }
  label.stack {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
    align-items: stretch;
  }
  .lbl-block {
    color: #b0b0b0;
    font-size: 0.85rem;
  }
  .preset-input {
    display: flex;
    gap: 0.4rem;
    align-items: stretch;
  }
  .preset-input input {
    flex: 1;
    min-width: 0;
  }
  .apply-all-row {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    flex-wrap: wrap;
    margin-top: 0.6rem;
  }
  .apply-all-ok {
    color: #86efac;
    font-size: 0.8rem;
  }
  .apply-all-error {
    margin: 0.4rem 0 0;
    padding: 0.5rem 0.7rem;
    background: #3a1818;
    border: 1px solid #5a2727;
    border-radius: 4px;
    color: #fca5a5;
    font-size: 0.78rem;
    white-space: pre-wrap;
    word-break: break-word;
    font-family: ui-monospace, 'Cascadia Code', Consolas, monospace;
  }
  select {
    background: #1a1a1a;
    border: 1px solid #3a3a3a;
    border-radius: 4px;
    color: #e0e0e0;
    padding: 0.25rem 0.45rem;
    font-family: inherit;
    font-size: 0.85rem;
  }
  textarea {
    width: 100%;
    background: #1a1a1a;
    border: 1px solid #3a3a3a;
    border-radius: 4px;
    color: #e0e0e0;
    padding: 0.5rem 0.7rem;
    font-family: ui-monospace, 'Cascadia Code', Consolas, monospace;
    font-size: 0.8rem;
    resize: vertical;
    box-sizing: border-box;
  }
  .explain {
    color: #888;
    font-size: 0.75rem;
    margin: 0;
  }
</style>
