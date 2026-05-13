<script lang="ts">
  import SyncLogPanel from './SyncLogPanel.svelte'

  interface Props {
    busy: boolean
    progressText: string | null
    syncLog: string[]
    onSyncNow: () => void
  }
  let { busy, progressText, syncLog, onSyncNow }: Props = $props()
</script>

<main>
  <div class="card">
    <h1>Your library is empty</h1>
    <p class="hint">
      ReHoarder hasn't synced your assets yet. Click below to fetch your Epic Vault and Fab library.
      This may take a minute for large libraries.
    </p>
    <button type="button" class="primary" disabled={busy} onclick={() => onSyncNow()}>
      {busy ? (progressText ?? 'Syncing…') : 'Sync now'}
    </button>

    {#if syncLog.length > 0}
      <div class="log-wrap">
        <SyncLogPanel {syncLog} open={busy} />
      </div>
    {/if}
  </div>
</main>

<style>
  main {
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 100vh;
    padding: 2rem;
  }

  .card {
    background: #242424;
    border: 1px solid #333;
    border-radius: 8px;
    padding: 2rem;
    max-width: 480px;
    text-align: center;
  }

  h1 {
    margin: 0 0 0.75rem;
    font-size: 1.5rem;
  }

  .hint {
    color: #a0a0a0;
    font-size: 0.9rem;
    margin: 0 0 1.25rem;
  }

  .primary {
    background: linear-gradient(135deg, #c084fc 0%, #f472b6 100%);
    color: white;
    border: none;
    border-radius: 4px;
    padding: 0.6rem 1.5rem;
    font-size: 0.95rem;
    font-weight: 500;
    cursor: pointer;
  }

  .primary:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .log-wrap {
    margin-top: 1.25rem;
    text-align: left;
  }
</style>
