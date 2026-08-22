<script lang="ts">
  import { onMount } from 'svelte'
  import { createAuthStore } from './stores/auth.svelte'
  import { createLibraryStore } from './stores/library.svelte'
  import { freebiesStore } from './stores/freebies.svelte'
  import { vaultStore } from './stores/vault.svelte'
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
  /** True when the user picked "Add account…" from the switcher — we bounce
   *  back to LoginView so they can paste the OAuth code from the browser,
   *  even though `auth.state` is still `authenticated` for the previous
   *  account. Cleared once submitCode succeeds (or the user navigates away). */
  let addingAccount = $state(false)
  /** When the startup check finds unclaimed freebies and the user opted in,
   *  this surfaces a non-blocking toast (bottom-right) with a "Go to
   *  Freebies" action. Dismissed manually or by navigating to the tab. */
  let freebiesToastCount = $state(0)

  onMount(async () => {
    await auth.refresh()
    if (auth.state.status === 'authenticated') {
      // Restore the user's startup-tab preference now that we know they're
      // landing in the authenticated UI. Done before library.refresh so the
      // visible tab is correct before any data lands.
      await restoreStartupTab()
      await library.refresh()
      void maybeNotifyAboutFreebies()
      // Warm the Vault scan in the background so opening the Vault tab is
      // instant. `vault:list` walks every file under each configured root
      // (size + mtime + count) — on a populated vault it can take 10+ s
      // even on NVMe, and that latency used to fire on every first tab open.
      // The store is a singleton, so this populates the cache for the
      // LocalVaultView / AssetLibraryView (downloaded filter) too.
      void vaultStore.ensureLoaded()
    }
  })

  /**
   * Restore the post-auth startup tab based on the user's preference:
   * - `last-opened` → the tab the user was on when they last closed the
   *   app (recorded by `persistActiveTab` below). Falls back to `assets`
   *   when there's no recorded value.
   * - any other value → that tab, pinned regardless of session history.
   *
   * Failures fall back silently to the default `assets` (which is already
   * the initial `$state` value), so a broken settings read can't trap the
   * user on a blank screen.
   */
  async function restoreStartupTab(): Promise<void> {
    try {
      const s = await window.api.settings.get()
      const wanted =
        s.startupTab === 'last-opened'
          ? (s.lastActiveTab ?? 'assets')
          : s.startupTab
      // Defensive: `settings` is never a valid landing destination — if it
      // somehow ended up persisted, fall back so the user doesn't open the
      // app into the settings page.
      activeTab = wanted === 'settings' ? 'assets' : (wanted as TabKey)
    } catch {
      /* keep the default activeTab */
    }
  }

  /**
   * On launch, ask the main process to do the cheap freebies probe: within
   * 7 days of the last check for this account it reports the last-seen
   * count with no network call, otherwise it fetches fresh and diffs
   * against the last-seen uids. No library sync is kicked either way. The
   * fetch updates the renderer cache so the badge is correct regardless of
   * the reason. When the user has opted into the popup AND there are
   * still-unclaimed freebies, surface the non-blocking toast.
   *
   * Failures stay silent; this is best-effort startup polish.
   */
  async function maybeNotifyAboutFreebies(): Promise<void> {
    try {
      const probe = await window.api.library.freebiesAutoCheck()
      // Refresh the renderer-side store so the TabBar badge reflects the
      // per-account claimed set the main process just resolved during the
      // weekly change-diff check.
      freebiesStore.invalidate()
      await freebiesStore.ensureLoaded()
      const settings = await window.api.settings.get()
      if (!settings.notifyAboutUnclaimedFreebiesOnStartup) return
      if (probe.unclaimedCount > 0 && freebiesStore.unclaimedCount > 0) {
        freebiesToastCount = freebiesStore.unclaimedCount
      }
    } catch {
      // Background check — never blocks the UI on failure.
    }
  }

  function openFreebiesFromToast(): void {
    handleTabChange('freebies')
  }

  function dismissFreebiesToast(): void {
    freebiesToastCount = 0
  }

  function handleTabChange(k: TabKey): void {
    activeTab = k
    // Opening Freebies from anywhere implicitly dismisses the startup toast.
    if (k === 'freebies') freebiesToastCount = 0
    // Persist the new tab so `startupTab: 'last-opened'` works on next launch.
    // `settings` is intentionally excluded — landing in Settings on startup
    // is awkward, so navigating there doesn't update the "last opened" memory.
    if (k !== 'settings') persistActiveTab(k)
  }

  /** Debounce timer for `lastActiveTab` writes. Tab clicks shouldn't fire a
   *  KV write each, especially when the user is shuffling tabs quickly.
   *  `$state` only to silence Svelte 5's dev-mode `non_reactive_update`
   *  warning; nothing in the template depends on this value. */
  let lastActiveTabTimer = $state<ReturnType<typeof setTimeout> | null>(null)

  function persistActiveTab(k: TabKey): void {
    if (lastActiveTabTimer) clearTimeout(lastActiveTabTimer)
    lastActiveTabTimer = setTimeout(() => {
      lastActiveTabTimer = null
      // Cast: `settings` was already filtered out by the caller; the main
      // process additionally sanitises with `sanitizeLastActiveTab`.
      void window.api.settings.set({ lastActiveTab: k as Exclude<TabKey, 'settings'> })
    }, 600)
  }

  /**
   * Wired to TabBar → AccountSwitcher. After the main process swaps the
   * active Epic account, every per-account store needs a fresh fetch:
   * library re-queries by the new account id, freebies + downloads reset
   * so the badges reflect the new account's state, and the startup toast
   * for unclaimed freebies is dismissed (it's no longer relevant — a
   * fresh check fires below).
   */
  async function handleAccountSwitched(_accountId: string): Promise<void> {
    freebiesToastCount = 0
    freebiesStore.invalidate()
    downloadsStore.invalidate()
    await auth.refresh()
    await library.refresh()
    void maybeNotifyAboutFreebies()
  }

  $effect(() => {
    if (auth.state.status === 'authenticated') {
      void library.refresh()
    }
  })

  // Marking freebies as claimed (single or "mark all") updates
  // `freebiesStore.unclaimedCount` optimistically. Once nothing is left
  // unclaimed, the startup toast is no longer relevant and should disappear
  // even if the user never opened the Freebies tab.
  $effect(() => {
    if (freebiesStore.unclaimedCount === 0) {
      freebiesToastCount = 0
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

{#if addingAccount}
  <LoginView
    busy={auth.busy}
    onStartLogin={() => auth.startLogin()}
    onSubmitCode={async (code) => {
      const r = await auth.submitCode(code)
      if (r.ok) {
        // New account became active; refresh per-account stores so the
        // library/downloads/freebies views render for the new identity.
        addingAccount = false
        freebiesStore.invalidate()
        downloadsStore.invalidate()
        await library.refresh()
        void maybeNotifyAboutFreebies()
      }
      return r
    }}
  />
{:else if auth.state.status === 'authenticated'}
  {#if library.initialLoading}
    <LoadingLibraryView />
  {:else}
    <TabBar
      active={activeTab}
      onChange={handleTabChange}
      onAccountSwitched={handleAccountSwitched}
      onAddAccount={() => (addingAccount = true)}
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
          onRefreshFromFab={async (a) => {
            const r = await window.api.library.refreshAssetFromFab(a.source, a.sourceId)
            // Re-pull the assets list so the updated image_url shows on the card.
            if (r.ok) await library.refresh()
            return r
          }}
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

{#if freebiesToastCount > 0 && activeTab !== 'freebies'}
  <div class="freebies-toast" role="status">
    <div class="ft-body">
      <strong>New freebies available</strong>
      <span class="ft-sub">
        {freebiesToastCount} unclaimed freebie{freebiesToastCount === 1 ? '' : 's'} this month
      </span>
    </div>
    <div class="ft-actions">
      <button type="button" class="ft-go" onclick={openFreebiesFromToast}>
        Go to Freebies
      </button>
      <button
        type="button"
        class="ft-close"
        onclick={dismissFreebiesToast}
        aria-label="Dismiss"
        title="Dismiss"
      >×</button>
    </div>
  </div>
{/if}

<style>
  .freebies-toast {
    position: fixed;
    bottom: 1.5rem;
    right: 1.5rem;
    z-index: 400;
    display: flex;
    align-items: center;
    gap: 0.9rem;
    max-width: 420px;
    padding: 0.7rem 0.9rem 0.7rem 1rem;
    background: #1f1f1f;
    border: 1px solid #3a3a3a;
    border-left: 3px solid #c084fc;
    border-radius: 6px;
    box-shadow: 0 6px 18px rgba(0, 0, 0, 0.55);
    color: #e0e0e0;
    font-size: 0.85rem;
  }
  .ft-body {
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
  }
  .ft-body strong {
    background: linear-gradient(135deg, #c084fc, #f472b6);
    -webkit-background-clip: text;
    background-clip: text;
    color: transparent;
    font-size: 0.92rem;
  }
  .ft-sub {
    color: #a0a0a0;
    font-size: 0.78rem;
  }
  .ft-actions {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    margin-left: auto;
  }
  .ft-go {
    background: linear-gradient(135deg, #c084fc, #f472b6);
    color: #fff;
    border: none;
    border-radius: 4px;
    padding: 0.4rem 0.75rem;
    font-size: 0.8rem;
    font-family: inherit;
    font-weight: 600;
    cursor: pointer;
  }
  .ft-go:hover {
    filter: brightness(1.1);
  }
  .ft-close {
    background: transparent;
    color: #888;
    border: none;
    font-size: 1.1rem;
    line-height: 1;
    padding: 0 0.25rem;
    cursor: pointer;
  }
  .ft-close:hover {
    color: #ddd;
  }
</style>
