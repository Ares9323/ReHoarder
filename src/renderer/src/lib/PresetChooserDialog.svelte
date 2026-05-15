<script lang="ts">
  import { onMount } from 'svelte'

  interface PresetMeta {
    id: string
    label: string
    description: string | null
    /** Optional integer count (plugins, chord rules, overrides …). Hidden when null. */
    count: number | null
  }

  interface ListResult {
    ok: boolean
    presets?: PresetMeta[]
    error?: string
  }

  interface UseResult {
    ok: boolean
    path?: string
    error?: string
  }

  interface Props {
    title: string
    subtitle: string
    /** Singular noun used in "N plugins" / "N chord rules" / "N overrides".
     *  Use an empty string to suppress the count column entirely. */
    unitLabel: string
    listFn: () => Promise<ListResult>
    useFn: (id: string) => Promise<UseResult>
    onClose: () => void
    onApplied?: (info: { path: string; label: string }) => void
  }

  let { title, subtitle, unitLabel, listFn, useFn, onClose, onApplied }: Props = $props()

  let presets = $state<PresetMeta[]>([])
  let loading = $state(true)
  let busy = $state(false)
  let error = $state<string | null>(null)
  let selectedId = $state<string | null>(null)
  let mouseDownOnBackdrop = $state(false)

  onMount(() => {
    void load()
  })

  async function load(): Promise<void> {
    loading = true
    error = null
    try {
      const r = await listFn()
      if (!r.ok) {
        error = r.error ?? 'Could not list templates'
        presets = []
        return
      }
      presets = r.presets ?? []
      selectedId = presets[0]?.id ?? null
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
    } finally {
      loading = false
    }
  }

  async function confirm(): Promise<void> {
    if (!selectedId || busy) return
    const chosen = presets.find((p) => p.id === selectedId)
    if (!chosen) return
    busy = true
    error = null
    try {
      const r = await useFn(chosen.id)
      if (!r.ok || !r.path) {
        error = r.error ?? 'Could not apply template'
        return
      }
      onApplied?.({ path: r.path, label: chosen.label })
      onClose()
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
    } finally {
      busy = false
    }
  }

  function formatCount(n: number): string {
    if (!unitLabel) return ''
    // Naive English pluralization: append 's' for everything except 1. Good enough
    // for the few labels we use ("plugin", "chord rule", "override").
    return `${n} ${unitLabel}${n === 1 ? '' : 's'}`
  }

  $effect(() => {
    const onKey = (e: globalThis.KeyboardEvent): void => {
      if (busy) return
      if (e.key === 'Escape') onClose()
      else if (e.key === 'Enter' && selectedId) void confirm()
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
    const onBackdrop = (e.target as HTMLElement).classList.contains('backdrop')
    if (onBackdrop && mouseDownOnBackdrop && !busy) onClose()
    mouseDownOnBackdrop = false
  }}
>
  <div class="popup" role="dialog" aria-modal="true" aria-label={title}>
    <header>
      <div class="head-lead">
        <h2>{title}</h2>
        <p class="subtitle">{subtitle}</p>
      </div>
      <button type="button" class="close" onclick={onClose} title="Close (Esc)">×</button>
    </header>

    {#if error}
      <div class="banner-error">{error}</div>
    {/if}

    {#if loading}
      <div class="state">Loading templates…</div>
    {:else if presets.length === 0}
      <div class="state empty">No built-in templates found.</div>
    {:else}
      <div class="list" role="listbox" aria-label="Available templates">
        {#each presets as p (p.id)}
          <button
            type="button"
            role="option"
            class="row"
            class:selected={selectedId === p.id}
            aria-selected={selectedId === p.id}
            ondblclick={() => {
              selectedId = p.id
              void confirm()
            }}
            onclick={() => (selectedId = p.id)}
          >
            <div class="row-head">
              <span class="label">{p.label}</span>
              {#if unitLabel && p.count !== null}
                <span class="count">{formatCount(p.count)}</span>
              {/if}
            </div>
            {#if p.description}
              <div class="desc">{p.description}</div>
            {/if}
          </button>
        {/each}
      </div>
    {/if}

    <footer>
      <button type="button" class="ghost" disabled={busy} onclick={onClose}>Cancel</button>
      <button
        type="button"
        class="primary"
        disabled={busy || loading || !selectedId}
        onclick={() => void confirm()}
      >
        {busy ? 'Applying…' : 'Use this template'}
      </button>
    </footer>
  </div>
</div>

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.65);
    z-index: 280;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .popup {
    width: min(560px, 92vw);
    max-height: min(640px, 90vh);
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
  .head-lead {
    min-width: 0;
    flex: 1;
  }
  header h2 {
    margin: 0;
    font-size: 0.95rem;
    color: #fff;
  }
  .subtitle {
    margin: 0.25rem 0 0;
    color: #9a9a9a;
    font-size: 0.78rem;
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
  .banner-error {
    background: #3a1818;
    color: #fca5a5;
    border-bottom: 1px solid #5a2020;
    padding: 0.55rem 1.1rem;
    font-size: 0.82rem;
    white-space: pre-wrap;
  }
  .state {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    color: #888;
    font-size: 0.9rem;
    padding: 2rem;
  }
  .state.empty {
    color: #b0b0b0;
  }
  .list {
    flex: 1;
    overflow: auto;
    display: flex;
    flex-direction: column;
    padding: 0.5rem;
    gap: 0.35rem;
  }
  .row {
    text-align: left;
    background: #1f1f1f;
    border: 1px solid #2c2c2c;
    border-radius: 6px;
    padding: 0.6rem 0.75rem;
    color: #d0d0d0;
    font-family: inherit;
    cursor: pointer;
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }
  .row:hover {
    border-color: #555;
    background: #242424;
  }
  .row.selected {
    border-color: #c084fc;
    background: #2a213a;
  }
  .row-head {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    gap: 0.6rem;
  }
  .label {
    font-size: 0.9rem;
    color: #f0f0f0;
    font-weight: 500;
  }
  .count {
    font-size: 0.72rem;
    color: #888;
    font-family: ui-monospace, 'Cascadia Code', Consolas, monospace;
  }
  .desc {
    font-size: 0.78rem;
    color: #9a9a9a;
    line-height: 1.4;
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
  .ghost:hover:not(:disabled) {
    color: #fff;
    border-color: #666;
  }
  .ghost:disabled {
    opacity: 0.55;
    cursor: not-allowed;
  }
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
  .primary:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }
</style>
