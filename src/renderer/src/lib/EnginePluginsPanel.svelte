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

  interface BaselineEntry {
    name: string
    upluginPath: string
    enabledByDefault: boolean
    installed: boolean
  }
  /** Baseline info: shown in the header when ReHoarder has previously
   *  captured the Day-0 state of this engine's plugins. */
  let baseline = $state<{
    exists: boolean
    createdAt?: number
    pluginCount?: number
    plugins: BaselineEntry[]
  }>({ exists: false, plugins: [] })
  let restoreConfirmOpen = $state(false)
  let restoring = $state(false)

  /** Active preset for the focused engine (per-engine override → global → null). */
  interface PresetEntry {
    name: string
    enabledByDefault: boolean
    installed: boolean
  }
  let preset = $state<{
    path: string | null
    source: 'per-engine' | 'global' | null
    entries: PresetEntry[]
    error: string | null
  }>({ path: null, source: null, entries: [], error: null })

  /** O(1) lookup of plugins currently in the preset, keyed by lowercase name. */
  const presetNames = $derived.by(() => {
    const s = new Set<string>()
    for (const e of preset.entries) s.add(e.name.toLowerCase())
    return s
  })

  /** Right-click context menu on a plugin row. Tracks which plugin was the
   *  click target so the menu items can act on it after the user moves the
   *  cursor onto the menu itself. */
  let pluginContextMenu = $state<{ x: number; y: number; plugin: EnginePluginRich } | null>(null)
  let uninstallTarget = $state<EnginePluginRich | null>(null)
  let uninstalling = $state(false)
  let statusToast = $state<string | null>(null)
  let statusToastTimer: ReturnType<typeof setTimeout> | null = null

  function flashStatus(msg: string): void {
    statusToast = msg
    if (statusToastTimer !== null) clearTimeout(statusToastTimer)
    statusToastTimer = setTimeout(() => {
      statusToast = null
      statusToastTimer = null
    }, 3000)
  }

  function openPluginContextMenu(e: MouseEvent, p: EnginePluginRich): void {
    e.preventDefault()
    pluginContextMenu = { x: e.clientX, y: e.clientY, plugin: p }
  }
  function closePluginContextMenu(): void {
    pluginContextMenu = null
  }
  $effect(() => {
    if (!pluginContextMenu) return
    const onKey = (e: globalThis.KeyboardEvent): void => {
      if (e.key === 'Escape') closePluginContextMenu()
    }
    const onMouseDown = (): void => closePluginContextMenu()
    window.addEventListener('keydown', onKey)
    window.addEventListener('mousedown', onMouseDown)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('mousedown', onMouseDown)
    }
  })

  async function ctxAddToConfig(): Promise<void> {
    if (!pluginContextMenu) return
    const p = pluginContextMenu.plugin
    closePluginContextMenu()
    const r = await window.api.engines.presetAddPlugin(engine.path, {
      name: p.name,
      enabledByDefault: p.enabledByDefault,
      installed: p.installed
    })
    if (!r.ok) {
      error = r.error ?? 'Preset write failed'
      return
    }
    flashStatus(`Added "${p.friendlyName}" to preset (${r.source})`)
    // Refresh preset entries so "Remove from config" toggles visibility.
    const presetRes = await window.api.engines.getPreset(engine.path)
    if (presetRes.ok) {
      preset = {
        path: presetRes.path ?? null,
        source: presetRes.source ?? null,
        entries: presetRes.entries ?? [],
        error: null
      }
    }
  }

  async function ctxRemoveFromConfig(): Promise<void> {
    if (!pluginContextMenu) return
    const p = pluginContextMenu.plugin
    closePluginContextMenu()
    const r = await window.api.engines.presetRemovePlugin(engine.path, p.name)
    if (!r.ok) {
      error = r.error ?? 'Preset write failed'
      return
    }
    flashStatus(
      r.removed ? `Removed "${p.friendlyName}" from preset` : `"${p.friendlyName}" wasn't in the preset`
    )
    const presetRes = await window.api.engines.getPreset(engine.path)
    if (presetRes.ok) {
      preset = {
        path: presetRes.path ?? null,
        source: presetRes.source ?? null,
        entries: presetRes.entries ?? [],
        error: null
      }
    }
  }

  function ctxUninstall(): void {
    if (!pluginContextMenu) return
    const p = pluginContextMenu.plugin
    closePluginContextMenu()
    uninstallTarget = p
  }

  async function confirmUninstall(): Promise<void> {
    if (!uninstallTarget || uninstalling) return
    const p = uninstallTarget
    uninstalling = true
    try {
      const r = await window.api.engines.uninstallPlugin(p.upluginPath)
      if (!r.ok) {
        error = r.error ?? 'Uninstall failed'
        return
      }
      flashStatus(`Uninstalled "${p.friendlyName}"`)
      uninstallTarget = null
      // Reload the plugin list — the row needs to disappear.
      await load()
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
    } finally {
      uninstalling = false
    }
  }

  /** Map of upluginPath → expected baseline flags, recomputed when the
   *  baseline reloads. O(1) lookup keeps the divergence count cheap even
   *  with hundreds of plugins. */
  const baselineByPath = $derived.by(() => {
    const m = new Map<string, BaselineEntry>()
    for (const b of baseline.plugins) m.set(b.upluginPath, b)
    return m
  })

  /**
   * How many plugins currently on disk differ from the baseline. Zero means
   * a Restore would be a no-op, so the banner stays hidden — the safety net
   * exists silently in the background until the user actually mutates state.
   */
  const baselineDivergenceCount = $derived(
    baseline.exists
      ? plugins.reduce((acc, p) => {
          const b = baselineByPath.get(p.upluginPath)
          if (!b) return acc
          return p.enabledByDefault !== b.enabledByDefault || p.installed !== b.installed
            ? acc + 1
            : acc
        }, 0)
      : 0
  )

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
      // Fetch baseline info on every load — it can transition exists=false
      // → exists=true after the first Apply on this engine.
      const info = await window.api.engines.readBaselineInfo(engine.path)
      baseline = {
        exists: info.exists,
        createdAt: info.createdAt,
        pluginCount: info.pluginCount,
        plugins: info.plugins ?? []
      }
      // Preset resolution is independent of baseline — it just tells us which
      // file (if any) the user pointed at for this engine, and surfaces its
      // entries so "Apply preset" can populate pending edits.
      const presetRes = await window.api.engines.getPreset(engine.path)
      if (presetRes.ok) {
        preset = {
          path: presetRes.path ?? null,
          source: presetRes.source ?? null,
          entries: presetRes.entries ?? [],
          error: null
        }
      } else {
        preset = {
          path: null,
          source: null,
          entries: [],
          error: presetRes.error ?? 'Preset error'
        }
      }
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
    } finally {
      loading = false
    }
  }

  function formatBaselineDate(ms: number | undefined): string {
    if (ms === undefined) return ''
    return new Date(ms).toLocaleString()
  }

  /** Replace the per-engine preset path with the file the user picks (or
   *  clear it when they cancel `unset` is called explicitly). Reloads the
   *  panel afterwards so the resolved-preset banner reflects the change. */
  async function pickPerEnginePreset(): Promise<void> {
    const r = await window.api.engines.pickPresetFile()
    if (!r.ok || !r.path) return
    const sr = await window.api.engines.setPresetPathPerEngine(engine.path, r.path)
    if (sr.ok) {
      await load()
    } else {
      error = sr.error ?? 'Could not set per-engine preset path'
    }
  }

  async function clearPerEnginePreset(): Promise<void> {
    const sr = await window.api.engines.setPresetPathPerEngine(engine.path, null)
    if (sr.ok) {
      await load()
    } else {
      error = sr.error ?? 'Could not clear per-engine preset path'
    }
  }

  /**
   * Populate pending edits from the active preset. For each preset entry, look
   * up the matching plugin by name and overwrite its flags in the local
   * `plugins` array — the user reviews via the Modified filter, then commits
   * with Apply changes. Plugins not mentioned in the preset are left alone.
   */
  function applyPresetToPending(): void {
    if (preset.entries.length === 0) return
    const byName = new Map<string, PresetEntry>(preset.entries.map((e) => [e.name, e]))
    plugins = plugins.map((p) => {
      const wanted = byName.get(p.name)
      if (!wanted) return p
      if (
        p.enabledByDefault === wanted.enabledByDefault &&
        p.installed === wanted.installed
      ) {
        return p
      }
      return { ...p, enabledByDefault: wanted.enabledByDefault, installed: wanted.installed }
    })
  }

  async function doRestore(): Promise<void> {
    if (restoring) return
    restoring = true
    error = null
    try {
      const r = await window.api.engines.restoreBaseline(engine.path)
      if (!r.ok) {
        error = r.error ?? 'Restore failed'
        return
      }
      if (r.failures && r.failures.length > 0) {
        error = `Restored ${r.restored ?? 0} plugin(s) — ${r.failures.length} failed:\n${r.failures
          .map((f) => `  ${f.name}: ${f.error}`)
          .join('\n')}`
      }
      restoreConfirmOpen = false
      // Re-read the on-disk state so the table reflects the restore + the
      // modified count drops back to zero.
      await load()
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
    } finally {
      restoring = false
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
      // The first successful Apply on an engine creates the baseline file
      // server-side. Refresh the summary so the Restore banner appears
      // without forcing the user to close and reopen the panel.
      try {
        const info = await window.api.engines.readBaselineInfo(engine.path)
        baseline = {
          exists: info.exists,
          createdAt: info.createdAt,
          pluginCount: info.pluginCount,
          plugins: info.plugins ?? []
        }
      } catch {
        /* ignore — purely cosmetic */
      }
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

  <div class="preset-row" class:no-preset={!preset.path}>
    <div class="preset-info">
      {#if preset.error}
        <span class="preset-error">Preset: {preset.error}</span>
      {:else if preset.path}
        <span>
          Preset ({preset.source}):
          <code class="preset-path" title={preset.path}>{preset.path}</code>
          · {preset.entries.length} entr{preset.entries.length === 1 ? 'y' : 'ies'}
        </span>
      {:else}
        <span class="muted">
          No preset configured. Set one per-engine, or define a global fallback in
          Settings → Engines.
        </span>
      {/if}
    </div>
    <div class="preset-actions">
      <button
        type="button"
        class="ghost-small"
        onclick={() => void pickPerEnginePreset()}
        disabled={saving || restoring}
      >
        {preset.source === 'per-engine' ? 'Change per-engine…' : 'Set per-engine…'}
      </button>
      {#if preset.source === 'per-engine'}
        <button
          type="button"
          class="ghost-small"
          onclick={() => void clearPerEnginePreset()}
          disabled={saving || restoring}
        >
          Clear override
        </button>
      {/if}
      <button
        type="button"
        class="ghost-small primary-small"
        onclick={applyPresetToPending}
        disabled={!preset.path || preset.entries.length === 0 || saving || restoring}
        title="Stage the preset's flags as pending edits — review with the Modified filter, then Apply changes."
      >
        Apply preset
      </button>
    </div>
  </div>

  {#if baseline.exists && baselineDivergenceCount > 0}
    <div class="baseline-row">
      <span class="baseline-label">
        <strong>{baselineDivergenceCount}</strong> plugin{baselineDivergenceCount === 1 ? '' : 's'}
        differ from the baseline captured {formatBaselineDate(baseline.createdAt)}.
      </span>
      <button
        type="button"
        class="ghost-small"
        onclick={() => (restoreConfirmOpen = true)}
        disabled={saving || restoring}
        title="Revert every diverging plugin to the state it had when ReHoarder first touched this engine"
      >
        Restore baseline
      </button>
    </div>
  {/if}

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
          <tr
            class="plugin-row"
            class:modified
            oncontextmenu={(e) => openPluginContextMenu(e, p)}
            title="Right-click for preset / uninstall actions"
          >
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

{#if pluginContextMenu}
  {@const cm = pluginContextMenu}
  {@const inPreset = presetNames.has(cm.plugin.name.toLowerCase())}
  {@const isMarketplace = cm.plugin.bucket.toLowerCase() === 'marketplace'}
  <div
    class="ctx-menu"
    role="menu"
    tabindex="-1"
    style:left="{cm.x}px"
    style:top="{cm.y}px"
    onmousedown={(e) => e.stopPropagation()}
  >
    <button type="button" role="menuitem" onclick={() => void ctxAddToConfig()}>
      Add to config
    </button>
    {#if inPreset}
      <button type="button" role="menuitem" onclick={() => void ctxRemoveFromConfig()}>
        Remove from config
      </button>
    {/if}
    {#if isMarketplace}
      <div class="ctx-sep"></div>
      <button type="button" role="menuitem" class="danger" onclick={ctxUninstall}>
        Uninstall plugin
      </button>
    {/if}
  </div>
{/if}

{#if uninstallTarget}
  {@const u = uninstallTarget}
  <div
    class="confirm-backdrop"
    role="presentation"
    onclick={(e) => {
      if (
        (e.target as HTMLElement).classList.contains('confirm-backdrop') &&
        !uninstalling
      ) {
        uninstallTarget = null
      }
    }}
  >
    <div class="confirm-popup" role="dialog" aria-modal="true" aria-label="Uninstall plugin">
      <h3>Uninstall plugin?</h3>
      <p>
        Permanently delete <strong>{u.friendlyName}</strong> from
        <code>{engine.name}</code>?
      </p>
      <p class="hint">
        Folder to remove: <code>{u.upluginPath.replace(/[/\\][^/\\]+\.uplugin$/i, '')}</code>
      </p>
      <div class="confirm-actions">
        <button type="button" class="ghost" disabled={uninstalling} onclick={() => (uninstallTarget = null)}>
          Cancel
        </button>
        <button
          type="button"
          class="danger-primary"
          disabled={uninstalling}
          onclick={() => void confirmUninstall()}
        >
          {uninstalling ? 'Uninstalling…' : 'Uninstall'}
        </button>
      </div>
    </div>
  </div>
{/if}

{#if statusToast}
  <div class="status-toast" role="status">{statusToast}</div>
{/if}

{#if restoreConfirmOpen}
  <div
    class="confirm-backdrop"
    role="presentation"
    onclick={(e) => {
      if (
        (e.target as HTMLElement).classList.contains('confirm-backdrop') &&
        !restoring
      ) {
        restoreConfirmOpen = false
      }
    }}
  >
    <div class="confirm-popup" role="dialog" aria-modal="true" aria-label="Restore baseline">
      <h3>Restore baseline?</h3>
      <p>
        Reverts <strong>{baselineDivergenceCount}</strong> diverging plugin{baselineDivergenceCount === 1 ? '' : 's'}
        on <code>{engine.name}</code> to the <code>EnabledByDefault</code> /
        <code>Installed</code> values captured on
        <strong>{formatBaselineDate(baseline.createdAt)}</strong>.
      </p>
      <p class="hint">
        Per-file <code>.bak</code> rollback still applies if any individual write
        fails. Modifications you haven't applied yet will be discarded.
      </p>
      <div class="confirm-actions">
        <button type="button" class="ghost" disabled={restoring} onclick={() => (restoreConfirmOpen = false)}>
          Cancel
        </button>
        <button
          type="button"
          class="danger-primary"
          disabled={restoring}
          onclick={() => void doRestore()}
        >
          {restoring ? 'Restoring…' : 'Restore baseline'}
        </button>
      </div>
    </div>
  </div>
{/if}

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
  .preset-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 0.8rem;
    margin-bottom: 0.5rem;
    padding: 0.45rem 0.7rem;
    background: #1a1a22;
    border: 1px solid #2c2c3a;
    border-radius: 4px;
    color: #b0b0b0;
    font-size: 0.78rem;
    flex-wrap: wrap;
  }
  .preset-row.no-preset {
    background: #1a1a1a;
    border-color: #2a2a2a;
  }
  .preset-info {
    flex: 1;
    min-width: 0;
  }
  .preset-info code.preset-path {
    background: #2a2a2a;
    padding: 0 0.3em;
    border-radius: 3px;
    color: #c0c0c0;
    font-size: 0.74rem;
    overflow-wrap: anywhere;
  }
  .preset-error {
    color: #fca5a5;
  }
  .muted {
    color: #777;
  }
  .preset-actions {
    display: flex;
    gap: 0.35rem;
    flex-wrap: wrap;
  }
  .primary-small {
    background: linear-gradient(135deg, #c084fc, #f472b6);
    color: #fff;
    border: none;
  }
  .primary-small:disabled {
    opacity: 0.4;
    cursor: not-allowed;
    background: linear-gradient(135deg, #6a4878, #75435c);
  }
  .baseline-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 0.8rem;
    margin-bottom: 0.7rem;
    padding: 0.45rem 0.7rem;
    background: #1a1d22;
    border: 1px solid #2c333d;
    border-radius: 4px;
    color: #b0b0b0;
    font-size: 0.78rem;
  }
  .baseline-label {
    color: #b0b0b0;
  }
  .confirm-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.6);
    z-index: 280;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .confirm-popup {
    width: 480px;
    max-width: 92vw;
    background: #1a1a1a;
    border: 1px solid #333;
    border-radius: 10px;
    box-shadow: 0 12px 36px rgba(0, 0, 0, 0.6);
    padding: 1.1rem 1.2rem 1rem;
  }
  .confirm-popup h3 {
    margin: 0 0 0.7rem;
    color: #fff;
    font-size: 1rem;
  }
  .confirm-popup p {
    margin: 0 0 0.6rem;
    color: #c0c0c0;
    font-size: 0.85rem;
    line-height: 1.4;
  }
  .confirm-popup .hint {
    color: #888;
    font-size: 0.78rem;
  }
  .confirm-popup code {
    background: #2a2a2a;
    padding: 0 0.25em;
    border-radius: 3px;
    color: #c0c0c0;
  }
  .confirm-actions {
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
    margin-top: 0.9rem;
  }
  .confirm-actions button {
    border: none;
    border-radius: 5px;
    padding: 0.45rem 1.1rem;
    font-family: inherit;
    font-size: 0.85rem;
    cursor: pointer;
  }
  .confirm-actions .ghost {
    background: transparent;
    color: #c0c0c0;
    border: 1px solid #444;
  }
  .confirm-actions .ghost:hover:not(:disabled) {
    color: #fff;
    border-color: #666;
  }
  .confirm-actions .danger-primary {
    background: linear-gradient(135deg, #fca5a5, #ef4444);
    color: #1a1a1a;
    font-weight: 600;
  }
  .confirm-actions .danger-primary:hover:not(:disabled) {
    filter: brightness(1.08);
  }
  .confirm-actions button:disabled {
    opacity: 0.45;
    cursor: not-allowed;
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
  tr.plugin-row {
    cursor: context-menu;
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
  .ctx-menu button.danger {
    color: #fca5a5;
  }
  .ctx-menu button.danger:hover {
    background: #3a1818;
    color: #fff;
  }
  .ctx-sep {
    height: 1px;
    margin: 0.25rem 0;
    background: #2e2e2e;
  }
  .status-toast {
    position: fixed;
    bottom: 1.5rem;
    right: 1.5rem;
    z-index: 350;
    background: #1f1f1f;
    border: 1px solid #3a3a3a;
    border-radius: 6px;
    padding: 0.55rem 0.9rem;
    font-size: 0.82rem;
    color: #d0d0d0;
    box-shadow: 0 4px 14px rgba(0, 0, 0, 0.55);
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
