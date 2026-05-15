<script lang="ts">
  import { onMount } from 'svelte'

  interface EngineSku {
    appName: string
    catalogItemId: string
    namespace: string
    buildVersion: string
    shortVersion: string
  }

  interface ComponentDescriptor {
    tag: string
    label: string
    defaultEnabled: boolean
    alwaysIncluded: boolean
    isPlatform: boolean
    requires?: string[]
    fileCount: number
    bytes: number
  }

  interface Props {
    sku: EngineSku
    onClose: () => void
    /** Fires when the user confirms install. Wired to the install IPC by
     *  the parent (EnginesView). */
    onConfirm?: (payload: {
      sku: EngineSku
      selectedTags: string[]
      installDir: string
      buildVersion: string
    }) => void
  }

  let { sku, onClose, onConfirm }: Props = $props()

  let loading = $state(true)
  let error = $state<string | null>(null)
  let summary = $state<{
    buildVersion: string
    components: ComponentDescriptor[]
    totalDecompressedBytes: number
  } | null>(null)
  /** Selected tag set — `Set` is reactive enough through reassignment. */
  let selectedTags = $state<Set<string>>(new Set())
  let installDir = $state('')
  let platformsExpanded = $state(false)
  let mouseDownOnBackdrop = $state(false)

  onMount(() => {
    void load()
    void loadDefaultInstallDir()
  })

  async function loadDefaultInstallDir(): Promise<void> {
    try {
      const r = await window.api.engineDownloads.suggestInstallDir(sku.appName)
      // Don't clobber if the user has already typed something while we waited.
      if (r.ok && r.path && installDir.length === 0) {
        installDir = r.path
      }
    } catch {
      // Best-effort — the user can always type or Browse.
    }
  }

  async function load(): Promise<void> {
    loading = true
    error = null
    try {
      const r = await window.api.engineDownloads.fetchInstallPlan({
        namespace: sku.namespace,
        catalogItemId: sku.catalogItemId,
        appName: sku.appName
      })
      if (!r.ok || !r.summary) {
        error = r.error ?? 'Could not fetch install plan'
        return
      }
      summary = {
        buildVersion: r.summary.buildVersion,
        components: r.summary.components,
        totalDecompressedBytes: r.summary.totalDecompressedBytes
      }
      // Seed selection from defaults + always-included.
      const next = new Set<string>()
      for (const c of r.summary.components) {
        if (c.alwaysIncluded || c.defaultEnabled) next.add(c.tag)
      }
      selectedTags = next
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
    } finally {
      loading = false
    }
  }

  /** Mirrors `applyDependencyRules` in main so we don't round-trip the IPC
   *  every checkbox click. Currently only one rule (tvOS → iOS) but coded
   *  generically against the `requires` field. */
  function toggleTag(tag: string, enabled: boolean): void {
    if (!summary) return
    const next = new Set(selectedTags)
    if (enabled) next.add(tag)
    else next.delete(tag)
    // Forward: enabled rows pull in their `requires`.
    let changed = true
    while (changed) {
      changed = false
      for (const c of summary.components) {
        if (!next.has(c.tag)) continue
        for (const req of c.requires ?? []) {
          if (!next.has(req)) {
            next.add(req)
            changed = true
          }
        }
      }
    }
    // Reverse: disabled rows drop everything that requires them.
    changed = true
    while (changed) {
      changed = false
      for (const c of summary.components) {
        if (next.has(c.tag)) continue
        for (const other of summary.components) {
          if ((other.requires ?? []).includes(c.tag) && next.has(other.tag)) {
            next.delete(other.tag)
            changed = true
          }
        }
      }
    }
    // Always-included tags can't be unselected.
    for (const c of summary.components) {
      if (c.alwaysIncluded) next.add(c.tag)
    }
    selectedTags = next
  }

  const totalSelectedBytes = $derived.by(() => {
    if (!summary) return 0
    let total = 0
    for (const c of summary.components) {
      if (selectedTags.has(c.tag)) total += c.bytes
    }
    return total
  })

  const nonPlatformComponents = $derived(
    summary?.components.filter((c) => !c.isPlatform) ?? []
  )
  const platformComponents = $derived(
    summary?.components.filter((c) => c.isPlatform) ?? []
  )
  const hasAnyPlatformSelected = $derived(
    platformComponents.some((c) => selectedTags.has(c.tag))
  )

  /** Older Unreal versions (~UE 4.x and early UE 5.x) ship without per-file
   *  `InstallTags`, so every file rolls up under the empty "Core" tag and
   *  there's literally nothing to break down. We surface a hint instead of
   *  showing what looks like a bare, pointless dialog. */
  const isMonolithicBundle = $derived(
    summary !== null && summary.components.length === 1 && summary.components[0].alwaysIncluded
  )

  /** Sum of bytes the user actually has to fetch (= selected tags' bytes).
   *  Real download size is smaller because some chunks are shared across
   *  tags — accurate compressed-bytes-per-selection requires walking the
   *  manifest, which task #15 will do when queueing. */
  function fmtBytes(n: number): string {
    if (n < 1024) return `${n} B`
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
    if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`
    return `${(n / (1024 * 1024 * 1024)).toFixed(1)} GB`
  }

  async function pickInstallDir(): Promise<void> {
    const r = await window.api.engineDownloads.pickInstallDir(installDir || null)
    if (!r.ok) {
      error = r.error ?? 'Could not open directory picker'
      return
    }
    if (r.path) installDir = r.path
  }

  async function confirm(): Promise<void> {
    if (!summary || loading) return
    if (selectedTags.size === 0) return
    onConfirm?.({
      sku,
      selectedTags: Array.from(selectedTags),
      installDir: installDir.trim(),
      buildVersion: summary.buildVersion
    })
  }

  $effect(() => {
    const onKey = (e: globalThis.KeyboardEvent): void => {
      if (loading) return
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })
</script>

<div
  class="backdrop"
  role="presentation"
  onmousedown={(e) => {
    mouseDownOnBackdrop = (e.target as HTMLElement).classList.contains('backdrop')
  }}
  onclick={(e) => {
    const onBd = (e.target as HTMLElement).classList.contains('backdrop')
    if (onBd && mouseDownOnBackdrop && !loading) onClose()
    mouseDownOnBackdrop = false
  }}
>
  <div class="popup" role="dialog" aria-modal="true" aria-label="Install Unreal Engine">
    <header>
      <div class="head-lead">
        <h2>Unreal Engine {sku.shortVersion} — Installation Options</h2>
        {#if summary?.buildVersion}
          <p class="subtitle">{summary.buildVersion}</p>
        {/if}
      </div>
      <button type="button" class="close" onclick={onClose} title="Close (Esc)">×</button>
    </header>

    {#if error}
      <div class="banner-error">{error}</div>
    {/if}

    {#if loading}
      <div class="state">Fetching install plan… (downloading {sku.appName} manifest)</div>
    {:else if !summary}
      <div class="state error">No install plan available.</div>
    {:else}
      {#if isMonolithicBundle}
        <div class="banner-info">
          This Unreal Engine build doesn't expose install components — it
          ships as a single bundle, so the full engine is installed in one
          shot. (Component selection was introduced in later UE versions.)
        </div>
      {/if}
      <div class="components">
        {#each nonPlatformComponents as c (c.tag)}
          <label class="row" class:disabled={c.alwaysIncluded}>
            <input
              type="checkbox"
              checked={selectedTags.has(c.tag)}
              disabled={c.alwaysIncluded}
              onchange={(e) => toggleTag(c.tag, (e.currentTarget as HTMLInputElement).checked)}
            />
            <span class="row-label">
              {c.label}
              {#if c.alwaysIncluded}<span class="required">(Required)</span>{/if}
            </span>
            <span class="row-size">{fmtBytes(c.bytes)}</span>
          </label>
        {/each}

        {#if platformComponents.length > 0}
          <button
            type="button"
            class="group-header"
            onclick={() => (platformsExpanded = !platformsExpanded)}
            aria-expanded={platformsExpanded}
          >
            <span class="chevron" class:open={platformsExpanded}>▶</span>
            Target Platforms
            {#if hasAnyPlatformSelected}
              <span class="group-tag">
                {platformComponents.filter((c) => selectedTags.has(c.tag)).length} selected
              </span>
            {/if}
          </button>
          {#if platformsExpanded}
            <div class="platform-group">
              {#each platformComponents as c (c.tag)}
                <label class="row platform-row">
                  <input
                    type="checkbox"
                    checked={selectedTags.has(c.tag)}
                    onchange={(e) => toggleTag(c.tag, (e.currentTarget as HTMLInputElement).checked)}
                  />
                  <span class="row-label">{c.label}</span>
                  <span class="row-size">{fmtBytes(c.bytes)}</span>
                </label>
              {/each}
            </div>
          {/if}
        {/if}
      </div>

      <div class="install-meta">
        <label class="stack">
          <span class="lbl-block">Install location</span>
          <div class="path-row">
            <input
              type="text"
              class="text-input"
              bind:value={installDir}
              spellcheck="false"
              placeholder={'e.g. D:\\UE_' + sku.shortVersion}
            />
            <button type="button" class="ghost" onclick={() => void pickInstallDir()}>
              Browse…
            </button>
          </div>
          <span class="hint">
            Pick an empty folder — the engine's <code>Engine/</code>, <code>Templates/</code>
            and friends land directly under here.
          </span>
        </label>
        <div class="size-summary">
          <div><strong>Selection size:</strong> {fmtBytes(totalSelectedBytes)}</div>
          <div class="hint">
            Compressed download size is computed when the install actually starts (some chunks are shared across components).
          </div>
        </div>
      </div>
    {/if}

    <footer>
      <button type="button" class="ghost" disabled={loading} onclick={onClose}>Cancel</button>
      <button
        type="button"
        class="primary"
        disabled={loading || !summary || selectedTags.size === 0 || installDir.trim().length === 0}
        onclick={() => void confirm()}
      >
        Install
      </button>
    </footer>
  </div>
</div>

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.65);
    z-index: 290;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .popup {
    width: min(640px, 95vw);
    max-height: min(780px, 92vh);
    background: #1a1a1a;
    border: 1px solid #333;
    border-radius: 10px;
    box-shadow: 0 12px 36px rgba(0, 0, 0, 0.6);
    display: flex;
    flex-direction: column;
  }
  header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    padding: 0.85rem 1.1rem;
    border-bottom: 1px solid #2a2a2a;
    background: #1f1f1f;
    gap: 0.6rem;
  }
  .head-lead { min-width: 0; flex: 1; }
  header h2 { margin: 0; font-size: 1rem; color: #fff; }
  .subtitle {
    margin: 0.2rem 0 0;
    color: #909090;
    font-size: 0.75rem;
    font-family: ui-monospace, 'Cascadia Code', Consolas, monospace;
  }
  .close {
    background: transparent;
    color: #999;
    border: 1px solid #3a3a3a;
    width: 32px; height: 32px;
    border-radius: 4px;
    font-size: 1.1rem;
    cursor: pointer;
    line-height: 1;
  }
  .close:hover { color: #fff; border-color: #666; }
  .banner-error {
    background: #3a1818;
    color: #fca5a5;
    border-bottom: 1px solid #5a2020;
    padding: 0.55rem 1.1rem;
    font-size: 0.82rem;
    white-space: pre-wrap;
  }
  .banner-info {
    background: #1c2533;
    color: #9ec5ff;
    border-bottom: 1px solid #2a3c5a;
    padding: 0.6rem 1.1rem;
    font-size: 0.8rem;
    line-height: 1.45;
  }
  .state {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    color: #888;
    font-size: 0.9rem;
    padding: 2rem;
    text-align: center;
  }
  .state.error { color: #fca5a5; }
  .components {
    flex: 1;
    overflow: auto;
    padding: 0.5rem 0.5rem 0;
    display: flex;
    flex-direction: column;
  }
  .row {
    display: grid;
    grid-template-columns: 1.5rem 1fr auto;
    align-items: center;
    gap: 0.6rem;
    padding: 0.55rem 0.75rem;
    border-bottom: 1px solid #232323;
    color: #d0d0d0;
    font-size: 0.88rem;
    cursor: pointer;
  }
  .row:hover { background: #1f1f1f; }
  .row.disabled { cursor: default; color: #c0c0c0; }
  .row-label { display: flex; align-items: center; gap: 0.4rem; }
  .row-size {
    color: #888;
    font-family: ui-monospace, 'Cascadia Code', Consolas, monospace;
    font-size: 0.78rem;
  }
  .required {
    color: #888;
    font-size: 0.72rem;
    font-style: italic;
  }
  .group-header {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.6rem 0.75rem;
    background: transparent;
    border: none;
    color: #d0d0d0;
    font-family: inherit;
    font-size: 0.88rem;
    text-align: left;
    cursor: pointer;
    border-bottom: 1px solid #232323;
  }
  .group-header:hover { background: #1f1f1f; }
  .chevron {
    display: inline-block;
    transition: transform 0.15s ease;
    font-size: 0.7rem;
    color: #888;
  }
  .chevron.open { transform: rotate(90deg); }
  .group-tag {
    margin-left: auto;
    color: #c084fc;
    font-size: 0.72rem;
    font-family: ui-monospace, 'Cascadia Code', Consolas, monospace;
  }
  .platform-group {
    padding-left: 1.2rem;
    background: #181818;
  }
  .platform-row { padding-left: 0.5rem; }
  .install-meta {
    border-top: 1px solid #2a2a2a;
    padding: 0.85rem 1.1rem;
    background: #1d1d1d;
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
  }
  .stack { display: flex; flex-direction: column; gap: 0.3rem; }
  .lbl-block {
    color: #c0c0c0;
    font-size: 0.78rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .path-row { display: flex; gap: 0.4rem; align-items: stretch; }
  .text-input {
    flex: 1;
    min-width: 0;
    background: #111;
    color: #e0e0e0;
    border: 1px solid #333;
    border-radius: 5px;
    padding: 0.45rem 0.6rem;
    font-family: ui-monospace, 'Cascadia Code', Consolas, monospace;
    font-size: 0.82rem;
  }
  .hint { color: #888; font-size: 0.72rem; }
  .size-summary {
    color: #d0d0d0;
    font-size: 0.85rem;
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
  }
  footer {
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
    padding: 0.85rem 1.1rem;
    border-top: 1px solid #2a2a2a;
    background: #1f1f1f;
  }
  .ghost {
    background: transparent;
    color: #c0c0c0;
    border: 1px solid #444;
    border-radius: 5px;
    padding: 0.45rem 1rem;
    font-family: inherit;
    font-size: 0.82rem;
    cursor: pointer;
  }
  .ghost:hover:not(:disabled) { color: #fff; border-color: #666; }
  .ghost:disabled { opacity: 0.55; cursor: not-allowed; }
  .primary {
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
  .primary:disabled { opacity: 0.45; cursor: not-allowed; }
</style>
