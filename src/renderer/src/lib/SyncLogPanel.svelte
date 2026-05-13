<script lang="ts">
  interface Props {
    syncLog: string[]
    open?: boolean
  }
  let { syncLog, open = false }: Props = $props()

  let copyState = $state<'idle' | 'copied' | 'error'>('idle')
  let copyTimer: ReturnType<typeof window.setTimeout> | null = null

  async function copyAll(event: globalThis.MouseEvent): Promise<void> {
    event.preventDefault()
    event.stopPropagation()
    try {
      await window.navigator.clipboard.writeText(syncLog.join('\n'))
      copyState = 'copied'
    } catch {
      copyState = 'error'
    }
    if (copyTimer) window.clearTimeout(copyTimer)
    copyTimer = window.setTimeout(() => {
      copyState = 'idle'
      copyTimer = null
    }, 1500)
  }
</script>

<details class="log-panel" {open}>
  <summary>
    <span class="title">Sync log ({syncLog.length} entries)</span>
    <button
      class="copy-btn"
      type="button"
      onclick={copyAll}
      disabled={syncLog.length === 0}
      title="Copy the full log to clipboard"
    >
      {#if copyState === 'copied'}Copied!{:else if copyState === 'error'}Copy failed{:else}Copy all{/if}
    </button>
  </summary>
  <pre>{syncLog.join('\n')}</pre>
</details>

<style>
  .log-panel {
    background: #1a1a1a;
    border: 1px solid #333;
    border-radius: 4px;
    padding: 0.5rem 0.75rem;
    font-size: 0.75rem;
  }
  summary {
    cursor: pointer;
    color: #a0a0a0;
    user-select: none;
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
  .title {
    flex: 1;
  }
  .copy-btn {
    background: #2a2a2a;
    color: #c0c0c0;
    border: 1px solid #444;
    border-radius: 3px;
    padding: 0.2rem 0.6rem;
    font-size: 0.7rem;
    font-family: inherit;
    cursor: pointer;
  }
  .copy-btn:hover:not(:disabled) {
    background: #333;
    color: #fff;
  }
  .copy-btn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }
  pre {
    margin: 0.5rem 0 0;
    max-height: 240px;
    overflow: auto;
    color: #c0c0c0;
    font-family: ui-monospace, 'Cascadia Code', Consolas, monospace;
    font-size: 0.7rem;
    white-space: pre-wrap;
    word-break: break-word;
  }
</style>
