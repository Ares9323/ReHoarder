<script lang="ts">
  import { onMount } from 'svelte'

  interface DiffOp {
    kind: 'same' | 'remove' | 'add'
    text: string
    leftLine?: number
    rightLine?: number
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
    /** Fires after a successful Apply — caller can refresh state. */
    onApplied?: (info: { summary?: string }) => void
  }

  let { engine, onClose, onApplied }: Props = $props()

  let loading = $state(true)
  let applying = $state(false)
  let error = $state<string | null>(null)
  let diff = $state<DiffOp[]>([])
  let summary = $state<string | null>(null)
  let warnings = $state<string[]>([])
  let willCaptureBaseline = $state(false)
  let mouseDownOnBackdrop = $state(false)

  onMount(() => {
    void load()
  })

  async function load(): Promise<void> {
    loading = true
    error = null
    try {
      const r = await window.api.engines.previewEditorSettings(engine.path)
      if (!r.ok) {
        error = r.error ?? 'Preview failed'
        return
      }
      diff = r.diff ?? []
      summary = r.summary ?? null
      warnings = r.warnings ?? []
      willCaptureBaseline = r.willCaptureBaseline ?? false
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
    } finally {
      loading = false
    }
  }

  async function doApply(): Promise<void> {
    if (applying) return
    applying = true
    error = null
    try {
      const r = await window.api.engines.applyEditorSettings(engine.path)
      if (!r.ok) {
        error = r.error ?? 'Apply failed'
        return
      }
      onApplied?.({ summary: r.summary })
      onClose()
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
    } finally {
      applying = false
    }
  }

  /** True if the diff has at least one change (otherwise the master is a
   *  no-op for this engine and Apply would be wasted work). */
  const hasChanges = $derived(diff.some((op) => op.kind !== 'same'))

  /** Counts surfaced in the header so the user has the big picture at a glance. */
  const counts = $derived.by(() => {
    let added = 0
    let removed = 0
    for (const op of diff) {
      if (op.kind === 'add') added++
      else if (op.kind === 'remove') removed++
    }
    return { added, removed }
  })

  $effect(() => {
    const onKey = (e: globalThis.KeyboardEvent): void => {
      if (applying) return
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
    const onBackdrop = (e.target as HTMLElement).classList.contains('backdrop')
    if (onBackdrop && mouseDownOnBackdrop && !applying) onClose()
    mouseDownOnBackdrop = false
  }}
>
  <div class="popup" role="dialog" aria-modal="true" aria-label="Editor settings preview">
    <header>
      <div class="head-lead">
        <h2>Editor settings diff · {engine.name}</h2>
        {#if summary}
          <p class="subtitle" title={summary}>
            {summary}
            {#if counts.added > 0 || counts.removed > 0}
              <span class="counts">
                <span class="counts-add">+{counts.added}</span>
                <span class="counts-rem">-{counts.removed}</span>
              </span>
            {/if}
            {#if willCaptureBaseline}
              <span class="badge">first apply → .bak captured</span>
            {/if}
          </p>
        {/if}
      </div>
      <button type="button" class="close" onclick={onClose} title="Close (Esc)">×</button>
    </header>

    {#if warnings.length > 0}
      <div class="warnings">
        {#each warnings as w (w)}
          <div>⚠ {w}</div>
        {/each}
      </div>
    {/if}
    {#if error}
      <div class="banner-error">{error}</div>
    {/if}

    {#if loading}
      <div class="state">Computing diff…</div>
    {:else if !hasChanges}
      <div class="state empty">
        Master produces no changes against this engine — Apply would be a no-op.
      </div>
    {:else}
      <div class="diff" role="region" aria-label="Side-by-side diff">
        <div class="diff-head">
          <div class="col-head">Current</div>
          <div class="col-head">Proposed</div>
        </div>
        <div class="diff-body">
          {#each diff as op, i (i)}
            <div class="row" class:row-add={op.kind === 'add'} class:row-remove={op.kind === 'remove'}>
              <div class="cell left">
                <span class="ln">{op.leftLine ?? ''}</span>
                <pre class="text" class:placeholder={op.kind === 'add'}>{op.kind === 'add' ? '' : op.text}</pre>
              </div>
              <div class="cell right">
                <span class="ln">{op.rightLine ?? ''}</span>
                <pre class="text" class:placeholder={op.kind === 'remove'}>{op.kind === 'remove' ? '' : op.text}</pre>
              </div>
            </div>
          {/each}
        </div>
      </div>
    {/if}

    <footer>
      <button type="button" class="ghost" disabled={applying} onclick={onClose}>Cancel</button>
      <button
        type="button"
        class="primary"
        disabled={applying || loading || !hasChanges}
        onclick={() => void doApply()}
      >
        {applying ? 'Applying…' : 'Apply now'}
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
    width: min(1280px, 96vw);
    height: min(820px, 90vh);
    background: #1a1a1a;
    border: 1px solid #333;
    border-radius: 10px;
    box-shadow: 0 12px 36px rgba(0, 0, 0, 0.6);
    display: flex;
    flex-direction: column;
  }
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.85rem 1.1rem;
    border-bottom: 1px solid #2a2a2a;
    background: #1f1f1f;
  }
  .head-lead {
    min-width: 0;
  }
  header h2 {
    margin: 0;
    font-size: 0.95rem;
    color: #fff;
  }
  .subtitle {
    margin: 0.2rem 0 0;
    color: #b0b0b0;
    font-size: 0.78rem;
    display: flex;
    align-items: center;
    gap: 0.6rem;
    flex-wrap: wrap;
  }
  .counts {
    display: inline-flex;
    gap: 0.5rem;
    font-family: ui-monospace, 'Cascadia Code', Consolas, monospace;
    font-size: 0.78rem;
  }
  .counts-add {
    color: #86efac;
  }
  .counts-rem {
    color: #fca5a5;
  }
  .badge {
    background: #2a213a;
    color: #d8b4fe;
    border: 1px solid #6b46c1;
    border-radius: 3px;
    padding: 0.05rem 0.4rem;
    font-size: 0.7rem;
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
  .warnings {
    padding: 0.55rem 1.1rem;
    background: #2a230f;
    border-bottom: 1px solid #4a3a18;
    color: #fbbf24;
    font-size: 0.78rem;
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
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
    color: #86efac;
  }
  .diff {
    flex: 1;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  .diff-head {
    display: grid;
    grid-template-columns: 1fr 1fr;
    background: #1f1f1f;
    border-bottom: 1px solid #2a2a2a;
  }
  .col-head {
    padding: 0.4rem 0.7rem;
    color: #888;
    font-size: 0.72rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  .col-head:first-child {
    border-right: 1px solid #2a2a2a;
  }
  .diff-body {
    flex: 1;
    overflow: auto;
    font-family: ui-monospace, 'Cascadia Code', Consolas, monospace;
    font-size: 0.78rem;
    line-height: 1.4;
  }
  .row {
    display: grid;
    grid-template-columns: 1fr 1fr;
  }
  .cell {
    display: grid;
    grid-template-columns: 3.2rem 1fr;
    gap: 0.2rem;
    padding: 0 0.2rem;
    align-items: start;
    min-width: 0;
  }
  .cell.left {
    border-right: 1px solid #2a2a2a;
  }
  .ln {
    color: #555;
    text-align: right;
    user-select: none;
    padding-right: 0.4rem;
    border-right: 1px solid #242424;
  }
  .text {
    margin: 0;
    padding: 0 0.4rem;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    font: inherit;
    color: #c0c0c0;
  }
  .text.placeholder {
    color: #2a2a2a;
  }
  /* Left cell of an "add" row = empty placeholder. Tint it gently so the eye
     follows the alignment without distracting from the actual new content
     on the right. */
  .row-add .left {
    background: #18241b;
  }
  .row-add .right {
    background: #1d3520;
  }
  .row-add .right .text {
    color: #d6f0d8;
  }
  .row-remove .left {
    background: #351d1d;
  }
  .row-remove .left .text {
    color: #f0d6d6;
  }
  .row-remove .right {
    background: #241818;
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
