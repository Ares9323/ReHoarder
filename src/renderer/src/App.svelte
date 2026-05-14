<script lang="ts">
  import { onMount } from 'svelte'
  import { createAuthStore } from './stores/auth.svelte'
  import { createLibraryStore } from './stores/library.svelte'
  import { freebiesStore } from './stores/freebies.svelte'
  import LoginView from './lib/LoginView.svelte'
  import EmptyLibraryView from './lib/EmptyLibraryView.svelte'
  import AssetLibraryView from './lib/AssetLibraryView.svelte'
  import LoadingLibraryView from './lib/LoadingLibraryView.svelte'
  import TabBar from './lib/TabBar.svelte'
  import type { TabKey } from './lib/tabs'
  import LocalVaultView from './lib/LocalVaultView.svelte'
  import EnginesView from './lib/EnginesView.svelte'
  import ProjectsView from './lib/ProjectsView.svelte'
  import DownloadsView from './lib/DownloadsView.svelte'
  import FreebiesView from './lib/FreebiesView.svelte'
  import SettingsView from './lib/SettingsView.svelte'

  const auth = createAuthStore()
  const library = createLibraryStore()

  let activeTab = $state<TabKey>('assets')

  onMount(async () => {
    await auth.refresh()
    if (auth.state.status === 'authenticated') {
      await library.refresh()
      void maybeFocusFreebiesTab()
    }
  })

  /**
   * Opt-in startup behavior: if `focusFreebiesTabAtStartup` is on and the
   * monthly freebies fetch reports unclaimed items, switch the active tab
   * to Freebies so the user lands there directly. Network failures stay
   * silent — they shouldn't disturb the normal boot flow.
   */
  async function maybeFocusFreebiesTab(): Promise<void> {
    try {
      const settings = await window.api.settings.get()
      if (!settings.focusFreebiesTabAtStartup) return
      await freebiesStore.ensureLoaded()
      if (freebiesStore.unclaimedCount > 0) activeTab = 'freebies'
    } catch {
      // Background check — never blocks the UI on failure.
    }
  }

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

  function isLibraryEmpty(): boolean {
    return (
      library.assets.length === 0 &&
      !library.syncBusy &&
      Object.keys(library.countsBySource).length === 0
    )
  }
</script>

{#if auth.state.status === 'authenticated'}
  {#if library.initialLoading}
    <LoadingLibraryView />
  {:else}
    <TabBar
      active={activeTab}
      onChange={(k) => (activeTab = k)}
      onSignOut={() => auth.logout()}
    />
    {#if activeTab === 'assets'}
      {#if isLibraryEmpty()}
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
          listingTypeFilter={library.listingTypeFilter}
          availableListingTypes={library.availableListingTypes}
          categoryFilter={library.categoryFilter}
          availableCategories={library.availableCategories}
          syncBusy={library.syncBusy}
          progressText={progressText()}
          syncError={library.syncError}
          syncLog={library.syncLog}
          onSearch={(s) => library.setSearch(s)}
          onSourceFilter={(f) => library.setSourceFilter(f)}
          onListingTypeFilter={(t) => library.setListingTypeFilter(t)}
          onCategoryFilter={(c) => library.setCategoryFilter(c)}
          onSyncNow={() => library.startSync()}
          onToggleHidden={(a) => library.setHidden(a, !a.hidden)}
          onToggleBookmark={(a) => library.setBookmarked(a, !a.bookmarked)}
        />
      {/if}
    {:else if activeTab === 'engines'}
      <EnginesView />
    {:else if activeTab === 'projects'}
      <ProjectsView />
    {:else if activeTab === 'vault'}
      <LocalVaultView />
    {:else if activeTab === 'freebies'}
      <FreebiesView />
    {:else if activeTab === 'settings'}
      <SettingsView />
    {:else if activeTab === 'downloads'}
      <DownloadsView />
    {/if}
  {/if}
{:else}
  <LoginView
    busy={auth.busy}
    onStartLogin={() => auth.startLogin()}
    onSubmitCode={(code) => auth.submitCode(code)}
  />
{/if}

