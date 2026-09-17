<script lang="ts">
  import { stripHtmlToText } from './description-utils'

  type AssetSource = 'vault' | 'fab' | 'legacy'

  interface EnqueueResult {
    ok: boolean
    error?: string
  }

  interface Props {
    title: string
    description: string | null
    imageUrl: string | null
    productUrl: string | null
    source: AssetSource
    hidden: boolean
    bookmarked: boolean
    /** Render the FAB / VAULT / LEGACY label on the thumbnail. Only worth the
     *  pixels when the library actually mixes sources — with a Fab-only library
     *  every card would carry the same badge. Purely informational: opening the
     *  listing is the thumbnail's job. */
    showSourceBadge?: boolean
    /** Display name of the asset's creator / seller / publisher. Rendered as a clickable link to a Fab search filtered by that name. `null` hides the row. */
    seller?: string | null
    /** Short labels of engine versions this asset is available for, e.g. `["5.4","5.6"]`. */
    engineVersions?: string[]
    /** Slugs the user has installed locally — used to decide if a chip can fast-path or must open Custom Install. */
    installedEngineVersions?: string[]
    /** Engine versions whose download is `status='done'` in the downloads table; chips matching one of these render in the "downloaded" style. The sentinel `'*'` marks a generic download (assets with no version chip, e.g. Fab Other). */
    downloadedVersions?: string[]
    /** Subset of `downloadedVersions` whose stored `buildVersion` differs from the current Fab raw — chips in this set render as "update available". */
    updatableVersions?: string[]
    /** What Fab calls the asset — drives the tooltip wording on already-downloaded chips. */
    assetKind?: 'plugin' | 'project' | 'pack' | 'other'
    /** Live download status (running/queued); when set, renders a progress strip along the bottom of the card. */
    downloadProgress?: { bytesDone: number; bytesTotal: number; status: string } | null
    /** When true, plugin auto-install logic kicks in (clicks on installed versions go through the engine plugin path). */
    isPlugin?: boolean
    onToggleHidden: () => void
    onToggleBookmark: () => void
    /** Fab-only: pulls the live listing detail and updates the asset's
     *  thumbnail in the local DB. Resolves with `{ok, imageUrl?, error?}`. */
    onRefreshFromFab?: () => Promise<{
      ok: boolean
      imageUrl?: string | null
      error?: string
    }>
    /** Click on an engine-version chip the user has installed. The version slug ("5.4") is what reached the chip. */
    onDownloadVersion?: (engineVersion: string) => Promise<EnqueueResult>
    /** Click on the gear chip OR on a non-installed version chip — opens the Custom Install menu. */
    onCustomInstall?: (engineVersion?: string) => void
    /** Click on the standalone Download chip (used for assets with no per-version split, e.g. Fab Other). */
    onDownload?: () => Promise<EnqueueResult>
    /** When set, the asset has no Unreal Engine build ReHoarder can fetch (UEFN,
     *  Blender, FBX, … listings from the Fab Other library). Replaces the
     *  Download chip with a "Get on Fab" link carrying this text as its
     *  tooltip, instead of a button that always fails. */
    externalOnlyReason?: string | null
  }

  let {
    title,
    description,
    imageUrl,
    productUrl,
    source,
    hidden,
    bookmarked,
    showSourceBadge = false,
    seller = null,
    engineVersions = [],
    installedEngineVersions = [],
    downloadedVersions = [],
    updatableVersions = [],
    assetKind = 'other',
    downloadProgress = null,
    isPlugin = false,
    onToggleHidden,
    onToggleBookmark,
    onRefreshFromFab,
    onDownloadVersion,
    onCustomInstall,
    onDownload,
    externalOnlyReason = null
  }: Props = $props()

  let refreshingFromFab = $state(false)
  let refreshFromFabError = $state<string | null>(null)

  // Context-menu state. Anchored in viewport coordinates (clientX/Y), shown as a
  // small floating menu. Closes on any pointerdown outside it, on Escape, or on
  // window blur (handled via $effect attaching listeners while open).
  let menuOpen = $state(false)
  let menuX = $state(0)
  let menuY = $state(0)

  function openMenu(e: globalThis.MouseEvent): void {
    e.preventDefault()
    menuX = e.clientX
    menuY = e.clientY
    menuOpen = true
  }

  function closeMenu(): void {
    menuOpen = false
  }

  function handleToggleHiddenFromMenu(): void {
    closeMenu()
    onToggleHidden()
  }

  function handleToggleBookmarkFromMenu(): void {
    closeMenu()
    onToggleBookmark()
  }

  async function handleRefreshFromFab(): Promise<void> {
    closeMenu()
    if (!onRefreshFromFab || refreshingFromFab) return
    refreshingFromFab = true
    refreshFromFabError = null
    try {
      const r = await onRefreshFromFab()
      if (!r.ok) refreshFromFabError = r.error ?? 'Refresh failed'
    } catch (err) {
      refreshFromFabError = err instanceof Error ? err.message : String(err)
    } finally {
      refreshingFromFab = false
    }
  }

  $effect(() => {
    if (!menuOpen) return
    const onPointerDown = (ev: globalThis.PointerEvent): void => {
      const target = ev.target as HTMLElement | null
      if (target && target.closest('.ctx-menu')) return
      closeMenu()
    }
    const onKey = (ev: globalThis.KeyboardEvent): void => {
      if (ev.key === 'Escape') closeMenu()
    }
    window.addEventListener('pointerdown', onPointerDown, true)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true)
      window.removeEventListener('keydown', onKey)
    }
  })

  const sourceLabel: Record<AssetSource, string> = {
    vault: 'Vault',
    fab: 'Fab',
    legacy: 'Legacy'
  }

  // Strip HTML once per description change. Many Fab Other listings ship the
  // body wrapped in `<ul><li><p>…</p></li></ul>`; rendering as text would expose
  // the tags. `$derived` so changes to `description` re-run cheaply.
  const cleanDescription = $derived(stripHtmlToText(description))

  type DownloadState =
    | { kind: 'idle' }
    | { kind: 'busy' }
    | { kind: 'queued' }
    | { kind: 'error'; message: string }

  /** Per-version state map so two consecutive version clicks don't share UI. */
  let versionStates = $state<Record<string, DownloadState>>({})
  function versionState(v: string): DownloadState {
    return versionStates[v] ?? { kind: 'idle' }
  }
  function setVersionState(v: string, s: DownloadState): void {
    versionStates = { ...versionStates, [v]: s }
  }

  /**
   * When a download we kicked off ends up in `downloadedVersions` (= the
   * library store's done-set), reset the local chip state back to `idle`.
   * Without this the chip stays in its `queued`/`busy` style forever — the
   * `ev-downloaded` class is gated on `st.kind === 'idle'`, so the sibling
   * versions of the same projectVersion would flip green while the chip
   * the user actually clicked remained "queued".
   */
  $effect(() => {
    for (const v of downloadedVersions) {
      const cur = versionStates[v]
      if (cur && (cur.kind === 'queued' || cur.kind === 'busy')) {
        setVersionState(v, { kind: 'idle' })
      }
    }
  })

  /** Same idea but for the single Download chip (no per-version split). */
  $effect(() => {
    if (
      downloadedVersions.includes('*') &&
      (downloadState.kind === 'queued' || downloadState.kind === 'busy')
    ) {
      downloadState = { kind: 'idle' }
    }
  })

  let downloadState = $state<DownloadState>({ kind: 'idle' })

  /**
   * Decide what clicking a version chip should do.
   *
   *   - Already downloaded for this version (or a sibling version) → open the
   *     Custom Install menu, which routes to `installFromVault` (copy from disk,
   *     no re-download). The menu also exposes Re-download as a deliberate opt-in.
   *   - Not downloaded yet, plugin without matching engine installed → open
   *     the Custom Install menu pre-targeted at this version (user picks a
   *     different engine / a project / vault).
   *   - Otherwise → enqueue a download with this engine version (auto-route
   *     into the engine's Marketplace folder if it's a plugin + the engine is
   *     present, else the configured vault path).
   */
  function chipDecision(version: string): 'install-from-vault' | 'custom' | 'download' {
    if (downloadedVersions.includes(version)) return 'install-from-vault'
    if (isPlugin && !installedEngineVersions.includes(version)) return 'custom'
    return 'download'
  }

  async function handleVersionClick(version: string): Promise<void> {
    const decision = chipDecision(version)
    if (decision === 'install-from-vault' || decision === 'custom') {
      onCustomInstall?.(version)
      return
    }
    if (!onDownloadVersion) {
      onCustomInstall?.(version)
      return
    }
    const cur = versionState(version)
    if (cur.kind === 'busy') return
    setVersionState(version, { kind: 'busy' })
    try {
      const r = await onDownloadVersion(version)
      setVersionState(version, r.ok
        ? { kind: 'queued' }
        : { kind: 'error', message: r.error ?? 'Enqueue failed' })
    } catch (err) {
      setVersionState(version, {
        kind: 'error',
        message: err instanceof Error ? err.message : String(err)
      })
    }
  }

  async function handleDownload(): Promise<void> {
    if (!onDownload || downloadState.kind === 'busy') return
    downloadState = { kind: 'busy' }
    try {
      const r = await onDownload()
      if (r.ok) {
        downloadState = { kind: 'queued' }
      } else {
        downloadState = { kind: 'error', message: r.error ?? 'Enqueue failed' }
      }
    } catch (err) {
      downloadState = { kind: 'error', message: err instanceof Error ? err.message : String(err) }
    }
  }

  /**
   * Click on the thumbnail: open the marketplace listing in the user's default
   * browser. This replaces the old FAB / VAULT / LEGACY badge button — the
   * whole image is the affordance now (pointer cursor + hover zoom + tooltip).
   * No-op when there's no productUrl on the asset, in which case the image is
   * rendered as a plain non-interactive element.
   */
  function handleThumbClick(e: globalThis.MouseEvent): void {
    if (!productUrl) return
    e.preventDefault()
    e.stopPropagation()
    void window.open(productUrl, '_blank', 'noreferrer')
  }

  /**
   * Click on the seller line: open a Fab search URL filtered by the seller's
   * display name. Fab doesn't expose a stable seller-profile URL in the
   * library payload (no slug / uid for Fab UE), so we route through the
   * generic search instead — surfaces every listing whose seller / title /
   * description mentions the name, which is what a user clicking on the
   * creator would want ("show me more by them").
   */
  function handleSellerClick(e: globalThis.MouseEvent): void {
    if (!seller) return
    e.preventDefault()
    e.stopPropagation()
    const url = `https://www.fab.com/search?q=${encodeURIComponent(seller)}`
    void window.open(url, '_blank', 'noreferrer')
  }

  /**
   * Tooltip + chip label for an already-downloaded chip, by asset kind. Mirrors
   * the wording Epic Games Launcher / Fab use: "Create project" for full
   * projects, "Add to project" for asset packs, "Install" for plugins.
   * Re-download is implicit — clicking still triggers it, the wording just
   * reflects what the user is more likely to want next.
   */
  function downloadedTooltip(version: string): string {
    switch (assetKind) {
      case 'project':
        return `Create project from this build (engine ${version})`
      case 'pack':
        return `Add to project (engine ${version})`
      case 'plugin':
        return `Install in engine/project (engine ${version})`
      default:
        return `Already in vault — click to re-download (engine ${version})`
    }
  }

  function formatPct(p: { bytesDone: number; bytesTotal: number }): string {
    if (p.bytesTotal <= 0) return '0%'
    return Math.min(100, Math.round((p.bytesDone / p.bytesTotal) * 100)) + '%'
  }

  function downloadedTooltipGeneric(): string {
    switch (assetKind) {
      case 'project':
        return 'Create project from this build'
      case 'pack':
        return 'Add to project'
      case 'plugin':
        return 'Install in engine/project'
      default:
        return 'Already in vault — click to re-download'
    }
  }
</script>

<article class:hidden-card={hidden} oncontextmenu={openMenu}>
  <div class="thumb">
    {#if productUrl}
      <button
        type="button"
        class="thumb-link"
        title="Open on {sourceLabel[source]}"
        aria-label="Open {title} on {sourceLabel[source]}"
        onclick={handleThumbClick}
      >
        {#if imageUrl}
          <img src={imageUrl} alt="" loading="lazy" />
        {:else}
          <div class="thumb-placeholder">No image</div>
        {/if}
      </button>
    {:else if imageUrl}
      <img src={imageUrl} alt="" loading="lazy" />
    {:else}
      <div class="thumb-placeholder">No image</div>
    {/if}
    {#if bookmarked}
      <span class="bookmark-badge" title="Bookmarked">★</span>
    {/if}
    {#if showSourceBadge}
      <span class="source-badge source-{source}">{sourceLabel[source]}</span>
    {/if}
  </div>
  <div class="body">
    <h3 {title}>{title}</h3>
    {#if seller}
      <button
        type="button"
        class="seller"
        onclick={handleSellerClick}
        title={`See more from ${seller} on Fab`}
      >by {seller}</button>
    {/if}
    {#if cleanDescription}
      <p class="desc">{cleanDescription}</p>
    {/if}
    <div class="version-row">
      {#if engineVersions.length > 0 && onDownloadVersion}
        {#each engineVersions as v (v)}
          {@const st = versionState(v)}
          {@const isDownloaded = downloadedVersions.includes(v)}
          {@const isUpdatable = updatableVersions.includes(v)}
          <button
            type="button"
            class="ev-chip clickable"
            class:ev-busy={st.kind === 'busy'}
            class:ev-queued={st.kind === 'queued'}
            class:ev-error={st.kind === 'error'}
            class:ev-downloaded={isDownloaded && !isUpdatable && st.kind === 'idle'}
            class:ev-updatable={isUpdatable && st.kind === 'idle'}
            disabled={st.kind === 'busy' || st.kind === 'queued'}
            onclick={() => handleVersionClick(v)}
            title={st.kind === 'error'
              ? st.message
              : st.kind === 'queued'
                ? `Queued for engine ${v}`
                : isUpdatable
                  ? `Update available — click to re-download for engine ${v}`
                  : isDownloaded
                    ? downloadedTooltip(v)
                    : `Download for engine ${v}`}
          >
            {#if st.kind === 'queued'}⏱ {v}
            {:else if st.kind === 'busy'}…{v}
            {:else if st.kind === 'error'}✕ {v}
            {:else if isUpdatable}↻ {v}
            {:else if isDownloaded}✓ {v}
            {:else}{v}
            {/if}
          </button>
        {/each}
      {:else if onDownload}
        {@const genericDownloaded = downloadedVersions.includes('*')}
        <button
          type="button"
          class="ev-chip clickable"
          class:ev-busy={downloadState.kind === 'busy'}
          class:ev-queued={downloadState.kind === 'queued'}
          class:ev-error={downloadState.kind === 'error'}
          class:ev-downloaded={genericDownloaded && downloadState.kind === 'idle'}
          disabled={downloadState.kind === 'busy' || downloadState.kind === 'queued'}
          onclick={handleDownload}
          title={downloadState.kind === 'queued'
            ? 'Added to the Downloads queue'
            : downloadState.kind === 'error'
              ? downloadState.message
              : genericDownloaded
                ? downloadedTooltipGeneric()
                : 'Add to the Downloads queue'}
        >
          {#if downloadState.kind === 'queued'}⏱ Queued
          {:else if downloadState.kind === 'busy'}Queuing…
          {:else if downloadState.kind === 'error'}✕ Failed
          {:else if genericDownloaded}✓ Downloaded
          {:else}Download
          {/if}
        </button>
      {:else if externalOnlyReason}
        <button
          type="button"
          class="ev-chip ext-chip"
          class:clickable={!!productUrl}
          disabled={!productUrl}
          title={externalOnlyReason}
          onclick={handleThumbClick}
        >Get on Fab ↗</button>
      {/if}
      {#if onCustomInstall}
        <button
          type="button"
          class="gear-chip clickable"
          title="Custom install (choose engine, project, or download only)"
          onclick={() => onCustomInstall?.()}
          aria-label="Custom install"
        >⚙</button>
      {/if}
    </div>
  </div>
  {#if downloadProgress && (downloadProgress.status === 'running' || downloadProgress.status === 'queued')}
    <div
      class="dl-progress"
      class:queued={downloadProgress.status === 'queued'}
      title={downloadProgress.status === 'queued'
        ? 'Queued for download'
        : `Downloading… ${formatPct(downloadProgress)}`}
    >
      {#if downloadProgress.status === 'running' && downloadProgress.bytesTotal > 0}
        <div
          class="dl-progress-fill"
          style:width="{Math.min(100, (downloadProgress.bytesDone / downloadProgress.bytesTotal) * 100)}%"
        ></div>
      {/if}
    </div>
  {/if}
</article>

{#if menuOpen}
  <div
    class="ctx-menu"
    role="menu"
    style:left="{menuX}px"
    style:top="{menuY}px"
  >
    <button type="button" role="menuitem" onclick={handleToggleBookmarkFromMenu}>
      {bookmarked ? 'Remove from bookmarks' : 'Add to bookmarks'}
    </button>
    <button type="button" role="menuitem" onclick={handleToggleHiddenFromMenu}>
      {hidden ? 'Show in library' : 'Hide from library'}
    </button>
    {#if source === 'fab' && onRefreshFromFab}
      <button
        type="button"
        role="menuitem"
        onclick={() => void handleRefreshFromFab()}
        disabled={refreshingFromFab}
      >
        {refreshingFromFab ? 'Refreshing from Fab…' : 'Refresh from Fab'}
      </button>
    {/if}
  </div>
{/if}
{#if refreshFromFabError}
  <div class="refresh-error" onclick={() => (refreshFromFabError = null)} role="button" tabindex="0" onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') refreshFromFabError = null }}>
    {refreshFromFabError}
  </div>
{/if}

<style>
  article {
    background: #232325;
    border: 1px solid #333;
    border-radius: 8px;
    overflow: hidden;
    display: flex;
    flex-direction: column;
    position: relative;
  }

  /* Progress strip anchored at the bottom of the card while a download for
     this asset is queued or running. The fill tracks `bytesDone/bytesTotal`;
     `queued` state shows an indeterminate pulsing bar instead, since we don't
     have a byte total yet. */
  .dl-progress {
    position: absolute;
    left: 0;
    right: 0;
    bottom: 0;
    height: 3px;
    background: rgba(192, 132, 252, 0.18);
    overflow: hidden;
  }
  .dl-progress-fill {
    height: 100%;
    background: linear-gradient(90deg, #c084fc, #f472b6);
    transition: width 0.25s ease;
  }
  .dl-progress.queued::after {
    content: '';
    display: block;
    position: absolute;
    top: 0;
    left: -40%;
    width: 40%;
    height: 100%;
    background: linear-gradient(90deg, transparent, #c084fc, transparent);
    animation: dl-indeterminate 1.2s linear infinite;
  }
  @keyframes dl-indeterminate {
    0% { left: -40%; }
    100% { left: 100%; }
  }

  article.hidden-card {
    opacity: 0.55;
  }

  .thumb {
    position: relative;
    aspect-ratio: 16 / 9;
    background: #1a1a1a;
    overflow: hidden;
  }

  .thumb img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
  }

  /* The thumbnail is the "open the listing" affordance (it replaced the old
     clickable source badge). Reset the button chrome so it reads as a plain
     image, then lean on cursor + a subtle zoom to signal it's interactive.
     `.thumb` already clips with `overflow: hidden`, so the scaled image stays
     inside the card's rounded corner. */
  .thumb-link {
    display: block;
    width: 100%;
    height: 100%;
    padding: 0;
    border: none;
    background: transparent;
    font: inherit;
    color: inherit;
    cursor: pointer;
  }

  .thumb-link img,
  .thumb-link .thumb-placeholder {
    transition: transform 0.22s ease;
  }

  .thumb-link:hover img,
  .thumb-link:focus-visible img,
  .thumb-link:hover .thumb-placeholder,
  .thumb-link:focus-visible .thumb-placeholder {
    transform: scale(1.06);
  }

  .thumb-link:focus-visible {
    outline: 2px solid #c084fc;
    outline-offset: -2px;
  }

  @media (prefers-reduced-motion: reduce) {
    .thumb-link img,
    .thumb-link .thumb-placeholder {
      transition: none;
    }
    .thumb-link:hover img,
    .thumb-link:focus-visible img,
    .thumb-link:hover .thumb-placeholder,
    .thumb-link:focus-visible .thumb-placeholder {
      transform: none;
    }
  }

  .thumb-placeholder {
    display: flex;
    align-items: center;
    justify-content: center;
    height: 100%;
    color: #555;
    font-size: 0.85rem;
  }

  .source-badge {
    position: absolute;
    top: 0.5rem;
    right: 0.5rem;
    padding: 0.15rem 0.5rem;
    border-radius: 999px;
    font-size: 0.7rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    background: rgba(0, 0, 0, 0.7);
    color: white;
    border: none;
    font-family: inherit;
    /* Sits above the zooming thumbnail so the scale transform doesn't slide
       under / over it oddly. */
    z-index: 1;
    pointer-events: none;
  }

  .bookmark-badge {
    position: absolute;
    top: 0.4rem;
    left: 0.5rem;
    width: 1.4rem;
    height: 1.4rem;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border-radius: 50%;
    font-size: 0.95rem;
    line-height: 1;
    background: rgba(0, 0, 0, 0.7);
    color: #facc15;
    text-shadow: 0 0 4px rgba(250, 204, 21, 0.4);
    z-index: 1;
  }

  .source-vault {
    background: rgba(192, 132, 252, 0.85);
  }

  .source-fab {
    background: rgba(244, 114, 182, 0.85);
  }

  .source-legacy {
    background: rgba(107, 107, 107, 0.85);
  }

  .body {
    padding: 0.75rem 0.9rem 0.5rem;
    flex: 1;
  }

  h3 {
    margin: 0;
    font-size: 0.95rem;
    line-height: 1.3;
    overflow: hidden;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
  }

  .seller {
    display: inline-block;
    margin: 0.15rem 0 0;
    padding: 0;
    background: transparent;
    border: none;
    color: #888;
    font-family: inherit;
    font-size: 0.72rem;
    font-style: italic;
    line-height: 1.2;
    cursor: pointer;
    text-align: left;
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .seller:hover {
    color: #c084fc;
    text-decoration: underline;
  }

  .desc {
    color: #a0a0a0;
    font-size: 0.8rem;
    margin: 0.4rem 0 0;
    overflow: hidden;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
  }

  .version-row {
    display: flex;
    flex-wrap: wrap;
    gap: 0.25rem;
    margin-top: 0.55rem;
    align-items: center;
  }

  .ev-chip {
    background: #1f1f1f;
    color: #c0c0c0;
    border: 1px solid #2e2e2e;
    border-radius: 3px;
    padding: 0.1rem 0.5rem;
    font-size: 0.72rem;
    font-family: ui-monospace, 'Cascadia Code', Consolas, monospace;
    font-variant-numeric: tabular-nums;
    line-height: 1.25;
  }
  .ev-chip.clickable {
    cursor: pointer;
  }
  .ev-chip.clickable:hover:not(:disabled) {
    background: #2a1f3a;
    color: #d8b4fe;
    border-color: #4a3268;
  }
  .ev-chip:disabled {
    cursor: default;
  }
  .ev-chip.ev-busy {
    color: #fbbf77;
    border-color: #5a4128;
  }
  .ev-chip.ev-queued {
    /* Distinct from downloaded (green ✓): pulsing purple so the user can tell
       "queued for download, not done yet" at a glance. The badge on the
       Downloads tab mirrors the count and the pulse animation reinforces
       in-progress vs settled state. */
    color: #d8b4fe;
    background: #2a1f3a;
    border-color: #4a3268;
    animation: ev-pulse 1.6s ease-in-out infinite;
  }
  @keyframes ev-pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.55; }
  }
  .ev-chip.ev-downloaded {
    color: #86efac;
    background: #1a3328;
    border-color: #2f5a40;
  }
  .ev-chip.ev-downloaded.clickable:hover:not(:disabled) {
    background: #244736;
    color: #bbf7d0;
    border-color: #3e7a55;
  }
  .ev-chip.ev-updatable {
    color: #fbbf24;
    background: #3a2a14;
    border-color: #5a4128;
  }
  .ev-chip.ev-updatable.clickable:hover:not(:disabled) {
    background: #4c361a;
    color: #fde68a;
    border-color: #7a5a2c;
  }
  .ev-chip.ev-error {
    color: #fca5a5;
    background: #3a1f1f;
    border-color: #5a2727;
  }

  /* Listing with no downloadable UE build. Deliberately muted: it's an exit to
     the browser, not an action ReHoarder performs. */
  .ext-chip {
    color: #8a8a8a;
    border-style: dashed;
  }
  .ext-chip.clickable:hover {
    background: #2a1f3a;
    color: #d8b4fe;
    border-color: #4a3268;
  }

  .gear-chip {
    background: #1f1f1f;
    color: #888;
    border: 1px solid #2e2e2e;
    border-radius: 3px;
    padding: 0.1rem 0.5rem;
    font-size: 0.8rem;
    line-height: 1.25;
    margin-left: 0.15rem;
  }
  .gear-chip.clickable {
    cursor: pointer;
  }
  .gear-chip:hover {
    background: #2a1f3a;
    color: #c084fc;
    border-color: #4a3268;
  }

  .ctx-menu {
    position: fixed;
    z-index: 100;
    background: #1f1f1f;
    border: 1px solid #3a3a3a;
    border-radius: 6px;
    padding: 0.25rem;
    min-width: 160px;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.6);
    display: flex;
    flex-direction: column;
  }

  .ctx-menu button {
    text-align: left;
    background: transparent;
    color: #d0d0d0;
    border: none;
    padding: 0.4rem 0.7rem;
    font-size: 0.8rem;
    cursor: pointer;
    border-radius: 4px;
    font-family: inherit;
  }

  .ctx-menu button:hover {
    background: #2a1f3a;
    color: #fff;
  }
  .ctx-menu button:disabled {
    color: #777;
    cursor: wait;
  }

  .refresh-error {
    position: absolute;
    left: 0.4rem;
    right: 0.4rem;
    bottom: 0.4rem;
    padding: 0.35rem 0.55rem;
    background: rgba(60, 24, 24, 0.92);
    border: 1px solid #5a2020;
    border-radius: 4px;
    color: #fca5a5;
    font-size: 0.7rem;
    cursor: pointer;
    z-index: 5;
  }

  .body {
    padding-bottom: 0.75rem;
  }
</style>
