<script lang="ts">
  import { onMount } from 'svelte'
  import { createAuthStore } from './stores/auth.svelte'
  import { createLibraryStore } from './stores/library.svelte'
  import LoginView from './lib/LoginView.svelte'
  import EmptyLibraryView from './lib/EmptyLibraryView.svelte'
  import AssetLibraryView from './lib/AssetLibraryView.svelte'
  import LoadingLibraryView from './lib/LoadingLibraryView.svelte'

  const auth = createAuthStore()
  const library = createLibraryStore()

  onMount(async () => {
    await auth.refresh()
    if (auth.state.status === 'authenticated') {
      await library.refresh()
    }
  })

  $effect(() => {
    if (auth.state.status === 'authenticated') {
      void library.refresh()
    }
  })

  function progressText(): string | null {
    const p = library.syncProgress
    if (!p) return null
    if (p.phase === 'starting') return 'Starting sync…'
    if (p.phase === 'done') return null
    if (p.total === 0) {
      return p.phase === 'vault' ? 'Fetching Vault…' : 'Fetching Fab…'
    }
    return `Syncing… ${p.total} assets`
  }
</script>

{#if auth.state.status === 'authenticated'}
  {#if library.initialLoading}
    <LoadingLibraryView />
  {:else if library.assets.length === 0 && !library.syncBusy && Object.keys(library.countsBySource).length === 0}
    <EmptyLibraryView
      busy={library.syncBusy}
      progressText={progressText()}
      syncLog={library.syncLog}
      onSyncNow={() => library.startSync()}
    />
  {:else}
    <AssetLibraryView
      assets={library.assets}
      countsBySource={library.countsBySource}
      lastSync={library.lastSync}
      search={library.search}
      sourceFilter={library.sourceFilter}
      showHidden={library.showHidden}
      syncBusy={library.syncBusy}
      progressText={progressText()}
      syncError={library.syncError}
      syncLog={library.syncLog}
      onSearch={(s) => library.setSearch(s)}
      onSourceFilter={(f) => library.setSourceFilter(f)}
      onShowHidden={(v) => library.setShowHidden(v)}
      onSyncNow={() => library.startSync()}
      onToggleHidden={(a) => library.setHidden(a, !a.hidden)}
      onSignOut={() => auth.logout()}
    />
  {/if}
{:else}
  <LoginView
    busy={auth.busy}
    onStartLogin={() => auth.startLogin()}
    onSubmitCode={(code) => auth.submitCode(code)}
  />
{/if}
