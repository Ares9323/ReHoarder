<script lang="ts">
  import { onMount, onDestroy } from 'svelte'

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

  interface PluginEntry {
    Name?: string
    Enabled?: boolean
    /** Open-shape: a plugin entry can also carry MarketplaceURL, Optional, TargetAllowList, etc. */
    [k: string]: unknown
  }

  interface ModuleEntry {
    Name?: string
    Type?: string
    LoadingPhase?: string
    [k: string]: unknown
  }

  /** Open-shape `.uproject` JSON. Only fields we actively read get typed. */
  interface UProjectDescriptor {
    FileVersion?: number
    EngineAssociation?: string
    Category?: string
    Description?: string
    Modules?: ModuleEntry[]
    Plugins?: PluginEntry[]
    TargetPlatforms?: string[]
    [k: string]: unknown
  }

  interface Props {
    uprojectPath: string
    onClose: () => void
  }

  let { uprojectPath, onClose }: Props = $props()

  const KNOWN_PLATFORMS = ['Win64', 'Mac', 'Linux', 'Android', 'IOS', 'TVOS']

  let loading = $state(true)
  let saving = $state(false)
  let error = $state<string | null>(null)
  let descriptor = $state<UProjectDescriptor | null>(null)
  /** Snapshot of the descriptor as it was on disk — for dirty detection. */
  let pristineJson = $state<string>('')
  let advancedOpen = $state(false)

  let engines = $state<EngineInfo[]>([])

  /** Display title (just the filename minus the extension). */
  const projectName = $derived(
    uprojectPath.replace(/\\/g, '/').split('/').pop()?.replace(/\.uproject$/i, '') ?? '(unknown)'
  )

  async function load(): Promise<void> {
    loading = true
    error = null
    try {
      const r = await window.api.projects.readDescriptor(uprojectPath)
      if (!r.ok) {
        error = r.error ?? 'Failed to read descriptor'
        descriptor = null
        return
      }
      const json = (r.json ?? {}) as UProjectDescriptor
      // Ensure mutable copies of nested arrays so $state tracks them properly.
      descriptor = {
        ...json,
        Plugins: Array.isArray(json.Plugins) ? json.Plugins.map((p) => ({ ...p })) : [],
        TargetPlatforms: Array.isArray(json.TargetPlatforms) ? [...json.TargetPlatforms] : [],
        Modules: Array.isArray(json.Modules) ? json.Modules.map((m) => ({ ...m })) : []
      }
      pristineJson = JSON.stringify(json)
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
    } finally {
      loading = false
    }
  }

  async function loadEngines(): Promise<void> {
    try {
      const r = await window.api.engines.list()
      if (r.ok) engines = r.engines ?? []
    } catch {
      // best-effort: dropdown falls back to free text on failure
    }
  }

  onMount(() => {
    void load()
    void loadEngines()
  })

  // Close on Escape, but only while the panel is mounted.
  $effect(() => {
    const onKey = (e: globalThis.KeyboardEvent): void => {
      if (e.key === 'Escape' && !saving) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  // Lock body scroll while the panel is open so the page underneath doesn't drift.
  onMount(() => {
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = prev
    }
  })

  // Dirty when the live descriptor differs from the snapshot. JSON.stringify on
  // a small object is cheap; we re-run only when descriptor changes.
  const dirty = $derived(
    descriptor !== null && JSON.stringify(descriptor) !== pristineJson
  )

  function isPlatformChecked(p: string): boolean {
    if (!descriptor) return false
    const arr = descriptor.TargetPlatforms ?? []
    return arr.includes(p)
  }

  function togglePlatform(p: string): void {
    if (!descriptor) return
    const current = descriptor.TargetPlatforms ?? []
    if (current.includes(p)) {
      descriptor.TargetPlatforms = current.filter((x) => x !== p)
    } else {
      descriptor.TargetPlatforms = [...current, p]
    }
  }

  function setPluginEnabled(idx: number, enabled: boolean): void {
    if (!descriptor || !descriptor.Plugins) return
    descriptor.Plugins[idx] = { ...descriptor.Plugins[idx], Enabled: enabled }
    // Force reactivity by reassigning the array reference.
    descriptor.Plugins = [...descriptor.Plugins]
  }

  async function save(): Promise<void> {
    if (!descriptor) return
    saving = true
    error = null
    try {
      // Strip Svelte 5 $state proxies before sending over IPC — Electron's
      // structured-clone barfs on Proxy objects with "An object could not be
      // cloned". The descriptor is plain JSON-serialisable, so a stringify/parse
      // round-trip is the cleanest way to get a vanilla object tree.
      const payload: UProjectDescriptor = JSON.parse(JSON.stringify(descriptor))
      if ((payload.TargetPlatforms ?? []).length === 0) delete payload.TargetPlatforms
      if ((payload.Plugins ?? []).length === 0) delete payload.Plugins
      if ((payload.Modules ?? []).length === 0) delete payload.Modules

      const r = await window.api.projects.writeDescriptor(uprojectPath, payload)
      if (!r.ok) {
        error = r.error ?? 'Write failed'
        return
      }
      const fresh = (r.json ?? {}) as UProjectDescriptor
      descriptor = {
        ...fresh,
        Plugins: Array.isArray(fresh.Plugins) ? fresh.Plugins.map((p) => ({ ...p })) : [],
        TargetPlatforms: Array.isArray(fresh.TargetPlatforms) ? [...fresh.TargetPlatforms] : [],
        Modules: Array.isArray(fresh.Modules) ? fresh.Modules.map((m) => ({ ...m })) : []
      }
      pristineJson = JSON.stringify(fresh)
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
    } finally {
      saving = false
    }
  }

  onDestroy(() => {
    // Body overflow restore happens via the onMount cleanup.
  })
</script>

<div
  class="backdrop"
  role="presentation"
  onclick={(e) => {
    // Click outside the panel closes only when not editing — guard via dirty flag.
    if ((e.target as HTMLElement).classList.contains('backdrop') && !saving && !dirty) {
      onClose()
    }
  }}
>
  <div class="panel" role="dialog" aria-label="Edit .uproject" aria-modal="true">
    <header class="head">
      <div class="head-lead">
        <h2>Edit .uproject</h2>
        <p class="path">{uprojectPath}</p>
      </div>
      <button type="button" class="close" onclick={onClose} title="Close (Esc)">×</button>
    </header>

    {#if loading}
      <div class="state">Loading descriptor…</div>
    {:else if error && !descriptor}
      <div class="state error">{error}</div>
    {:else if descriptor}
      <div class="body">
        {#if error}
          <div class="banner-error">{error}</div>
        {/if}

        <h3>{projectName}</h3>

        <label class="row">
          <span class="lbl">Engine association</span>
          {#if engines.length > 0}
            <select bind:value={descriptor.EngineAssociation}>
              {#each engines as e (e.path)}
                <option value={e.version.split('.').slice(0, 2).join('.')}>
                  {e.name} ({e.version})
                </option>
              {/each}
              {#if descriptor.EngineAssociation && !engines.some((e) => e.version.split('.').slice(0, 2).join('.') === descriptor!.EngineAssociation)}
                <option value={descriptor.EngineAssociation}>
                  {descriptor.EngineAssociation} (current, not installed)
                </option>
              {/if}
            </select>
          {:else}
            <input type="text" bind:value={descriptor.EngineAssociation} placeholder="5.4" />
          {/if}
        </label>

        <label class="row">
          <span class="lbl">Category</span>
          <input type="text" bind:value={descriptor.Category} placeholder="(none)" />
        </label>

        <label class="stack">
          <span class="lbl">Description</span>
          <textarea rows="3" bind:value={descriptor.Description} placeholder="(none)"></textarea>
        </label>

        <div class="group">
          <h4>Target platforms</h4>
          <p class="explain">
            Empty = all platforms supported by the engine. Tick the ones you want to
            restrict to.
          </p>
          <div class="platforms">
            {#each KNOWN_PLATFORMS as p (p)}
              <label class="chip-check">
                <input
                  type="checkbox"
                  checked={isPlatformChecked(p)}
                  onchange={() => togglePlatform(p)}
                />
                <span>{p}</span>
              </label>
            {/each}
          </div>
        </div>

        <div class="group">
          <h4>Plugins ({(descriptor.Plugins ?? []).length})</h4>
          {#if (descriptor.Plugins ?? []).length === 0}
            <p class="explain">No plugins listed in this descriptor.</p>
          {:else}
            <ul class="plugins">
              {#each descriptor.Plugins ?? [] as plugin, idx (plugin.Name ?? idx)}
                <li class:disabled-plugin={plugin.Enabled === false}>
                  <label class="plugin-row">
                    <input
                      type="checkbox"
                      checked={plugin.Enabled !== false}
                      onchange={(e) =>
                        setPluginEnabled(
                          idx,
                          (e.currentTarget as HTMLInputElement).checked
                        )}
                    />
                    <span class="plugin-name">{plugin.Name ?? '(unnamed)'}</span>
                    {#if typeof plugin.MarketplaceURL === 'string'}
                      <span class="plugin-tag">Marketplace</span>
                    {/if}
                  </label>
                </li>
              {/each}
            </ul>
          {/if}
        </div>

        <div class="group">
          <button type="button" class="disclosure" onclick={() => (advancedOpen = !advancedOpen)}>
            <span class="chev">{advancedOpen ? '▾' : '▸'}</span>
            Advanced (read-only)
          </button>
          {#if advancedOpen}
            <div class="advanced">
              <div class="kv">
                <span class="kv-key">FileVersion</span>
                <span class="kv-val">{descriptor.FileVersion ?? '—'}</span>
              </div>
              <div class="kv">
                <span class="kv-key">Modules</span>
                <span class="kv-val">
                  {#if (descriptor.Modules ?? []).length === 0}
                    —
                  {:else}
                    <ul class="modules">
                      {#each descriptor.Modules ?? [] as m, i (m.Name ?? i)}
                        <li>
                          <span class="m-name">{m.Name ?? '(unnamed)'}</span>
                          {#if m.Type}<span class="m-meta">type: {m.Type}</span>{/if}
                          {#if m.LoadingPhase}<span class="m-meta">phase: {m.LoadingPhase}</span>{/if}
                        </li>
                      {/each}
                    </ul>
                  {/if}
                </span>
              </div>
            </div>
          {/if}
        </div>
      </div>

      <footer class="foot">
        <span class="dirty-hint">
          {#if dirty}Unsaved changes — close requires saving first.{/if}
        </span>
        <button type="button" onclick={onClose} disabled={saving}>Close</button>
        <button
          type="button"
          class="primary"
          disabled={!dirty || saving}
          onclick={save}
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
      </footer>
    {/if}
  </div>
</div>

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.55);
    z-index: 200;
    display: flex;
    justify-content: flex-end;
  }

  .panel {
    width: 520px;
    max-width: 100vw;
    height: 100vh;
    background: #1a1a1a;
    border-left: 1px solid #333;
    box-shadow: -8px 0 24px rgba(0, 0, 0, 0.45);
    display: flex;
    flex-direction: column;
    animation: slidein 160ms ease-out;
  }

  @keyframes slidein {
    from {
      transform: translateX(40px);
      opacity: 0;
    }
    to {
      transform: translateX(0);
      opacity: 1;
    }
  }

  .head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.85rem 1.1rem;
    border-bottom: 1px solid #2a2a2a;
    background: #1f1f1f;
  }
  .head-lead h2 {
    margin: 0;
    font-size: 0.85rem;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: #c084fc;
  }
  .path {
    margin: 0.25rem 0 0;
    color: #777;
    font-size: 0.72rem;
    font-family: ui-monospace, 'Cascadia Code', Consolas, monospace;
    word-break: break-all;
  }
  .close {
    background: transparent;
    color: #999;
    border: 1px solid #3a3a3a;
    width: 32px;
    height: 32px;
    border-radius: 4px;
    font-size: 1.1rem;
    cursor: pointer;
    line-height: 1;
  }
  .close:hover {
    color: #fff;
    border-color: #666;
  }

  .body {
    flex: 1;
    overflow-y: auto;
    padding: 1rem 1.1rem;
    display: flex;
    flex-direction: column;
    gap: 0.85rem;
  }
  h3 {
    margin: 0;
    color: #e0e0e0;
    font-size: 1rem;
  }
  h4 {
    margin: 0 0 0.3rem;
    font-size: 0.75rem;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: #c084fc;
  }
  .group {
    background: #242424;
    border: 1px solid #2e2e2e;
    border-radius: 6px;
    padding: 0.7rem 0.9rem;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
  .explain {
    margin: 0;
    color: #777;
    font-size: 0.72rem;
  }
  .banner-error {
    background: #3a1f1f;
    border: 1px solid #5a2727;
    color: #fca5a5;
    border-radius: 4px;
    padding: 0.5rem 0.7rem;
    font-size: 0.78rem;
  }

  .row {
    display: flex;
    align-items: center;
    gap: 0.6rem;
  }
  .stack {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
  }
  .lbl {
    color: #b0b0b0;
    font-size: 0.78rem;
    min-width: 140px;
  }
  input[type='text'],
  select,
  textarea {
    flex: 1;
    background: #1a1a1a;
    border: 1px solid #3a3a3a;
    border-radius: 4px;
    color: #e0e0e0;
    padding: 0.35rem 0.55rem;
    font-family: inherit;
    font-size: 0.82rem;
    box-sizing: border-box;
  }
  textarea {
    width: 100%;
    font-family: ui-monospace, 'Cascadia Code', Consolas, monospace;
    font-size: 0.78rem;
    resize: vertical;
  }
  input[type='checkbox'] {
    accent-color: #c084fc;
  }

  .platforms {
    display: flex;
    flex-wrap: wrap;
    gap: 0.4rem;
  }
  .chip-check {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    background: #1f1f1f;
    border: 1px solid #2e2e2e;
    border-radius: 999px;
    padding: 0.2rem 0.7rem;
    font-size: 0.78rem;
    color: #c0c0c0;
    cursor: pointer;
  }

  .plugins {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
    max-height: 360px;
    overflow-y: auto;
  }
  .plugins li {
    background: #1f1f1f;
    border: 1px solid #2a2a2a;
    border-radius: 4px;
    padding: 0.35rem 0.55rem;
  }
  .plugins li.disabled-plugin {
    opacity: 0.55;
  }
  .plugin-row {
    display: flex;
    align-items: center;
    gap: 0.55rem;
    cursor: pointer;
  }
  .plugin-name {
    color: #d0d0d0;
    font-size: 0.8rem;
    flex: 1;
    word-break: break-all;
  }
  .plugin-tag {
    font-size: 0.65rem;
    color: #888;
    background: #2a1f3a;
    border: 1px solid #4a3268;
    border-radius: 3px;
    padding: 0.05rem 0.4rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .disclosure {
    background: transparent;
    color: #c0c0c0;
    border: none;
    text-align: left;
    padding: 0.2rem 0;
    cursor: pointer;
    font-size: 0.78rem;
    font-family: inherit;
  }
  .chev {
    display: inline-block;
    width: 1rem;
    color: #c084fc;
  }
  .advanced {
    margin-top: 0.4rem;
    display: flex;
    flex-direction: column;
    gap: 0.45rem;
  }
  .kv {
    display: flex;
    gap: 0.55rem;
    font-size: 0.78rem;
  }
  .kv-key {
    color: #888;
    min-width: 110px;
  }
  .kv-val {
    color: #d0d0d0;
    word-break: break-all;
    flex: 1;
  }
  .modules {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }
  .modules li {
    background: #1f1f1f;
    border: 1px solid #2a2a2a;
    border-radius: 4px;
    padding: 0.3rem 0.5rem;
    font-size: 0.74rem;
  }
  .m-name {
    color: #d0d0d0;
    margin-right: 0.55rem;
  }
  .m-meta {
    color: #888;
    margin-right: 0.55rem;
    font-family: ui-monospace, 'Cascadia Code', Consolas, monospace;
    font-size: 0.7rem;
  }

  .foot {
    padding: 0.65rem 1.1rem;
    border-top: 1px solid #2a2a2a;
    background: #1f1f1f;
    display: flex;
    align-items: center;
    gap: 0.55rem;
  }
  .dirty-hint {
    flex: 1;
    color: #fbbf77;
    font-size: 0.72rem;
  }
  .foot button {
    background: transparent;
    color: #c0c0c0;
    border: 1px solid #444;
    border-radius: 4px;
    padding: 0.35rem 0.85rem;
    font-size: 0.8rem;
    cursor: pointer;
    font-family: inherit;
  }
  .foot button:hover:not(:disabled) {
    color: #fff;
    border-color: #666;
  }
  .foot button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .foot button.primary {
    background: linear-gradient(135deg, #c084fc, #f472b6);
    border: none;
    color: #fff;
    font-weight: 500;
  }
  .foot button.primary:disabled {
    opacity: 0.4;
  }

  .state {
    padding: 2rem 1rem;
    color: #b0b0b0;
    text-align: center;
  }
  .state.error {
    color: #fca5a5;
  }
</style>
