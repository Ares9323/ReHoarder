<script lang="ts">
  import { onMount } from 'svelte'
  import { createAuthStore } from './stores/auth.svelte'
  import { createLibraryStore } from './stores/library.svelte'
  import LoginView from './lib/LoginView.svelte'
  import EmptyLibraryView from './lib/EmptyLibraryView.svelte'
  import AssetLibraryView from './lib/AssetLibraryView.svelte'
  import LoadingLibraryView from './lib/LoadingLibraryView.svelte'
  import TabBar from './lib/TabBar.svelte'
  import type { TabKey } from './lib/tabs'
  import PlaceholderView from './lib/PlaceholderView.svelte'

  const auth = createAuthStore()
  const library = createLibraryStore()

  let activeTab = $state<TabKey>('assets')

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
    {:else if activeTab === 'engines'}
      <PlaceholderView
        title="Engines"
        blurb="Detect, list, and launch your local Unreal Engine installs."
        planned={[
          'Scan configured paths (default: C:\\Program Files\\Epic Games\\) for UE_*/Engine/Build/Build.version',
          'Show installed version, build path, and last-launched timestamp',
          'Launch UE Editor from the app and auto-exit ReHoarder to free RAM',
          'Pick the target engine when installing a plugin'
        ]}
      />
    {:else if activeTab === 'projects'}
      <PlaceholderView
        title="Projects"
        blurb="Index local Unreal projects and act on them in bulk."
        planned={[
          'Scan configured paths for *.uproject',
          'Show project name, engine version, last-opened timestamp',
          'Launch UE Editor for a project; open the project folder',
          'Bulk cleanup of Intermediate/Saved/DerivedDataCache across many projects',
          'Install a Fab asset directly into a chosen project'
        ]}
      />
    {:else if activeTab === 'vault'}
      <PlaceholderView
        title="Vault (local files)"
        blurb="Browse what's already on disk in your configured VaultCache."
        planned={[
          'Default vault path; multi-path support with drive-letter routing',
          'Show downloaded assets with size and last-modified timestamp',
          'Reverse-link to the matching library entry',
          'Right-click → reveal in file manager, delete, recompute SHA1 to detect corruption',
          'Show pending downloads (chunks in `cache/`) for in-progress assets'
        ]}
      />
    {:else if activeTab === 'settings'}
      <PlaceholderView
        title="Settings"
        blurb="Tune sync, downloads, and integrations."
        planned={[
          'Vault paths + UE install paths',
          'Concurrent downloads (asset-level and chunk-level)',
          'Compile plugins on install (Linux default on, Win/Mac off)',
          'Skip platform binaries for non-current platforms',
          'Auto-patch .uplugin PlatformAllowList',
          'Behavior on UBT compile failure (Keep / Remove / Ask)',
          'Optional CF warmup skip when cf_clearance is still fresh'
        ]}
      />
    {:else if activeTab === 'downloads'}
      <PlaceholderView
        title="Downloads"
        blurb="Queue, progress, and history of asset downloads."
        planned={[
          'Live progress per asset (bytes, throughput, ETA)',
          'Pause / resume / cancel per item',
          'Retry failed downloads',
          'Resume across app restarts (state persisted in SQLite)',
          'Filter: in-progress / queued / done / failed',
          'Click an entry to see the build log + plugin compile output'
        ]}
      />
    {/if}
  {/if}
{:else}
  <LoginView
    busy={auth.busy}
    onStartLogin={() => auth.startLogin()}
    onSubmitCode={(code) => auth.submitCode(code)}
  />
{/if}
