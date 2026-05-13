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
    /** Short labels of engine versions this asset is available for, e.g. `["5.4","5.6"]`. */
    engineVersions?: string[]
    onToggleHidden: () => void
    onToggleBookmark: () => void
    /** When provided, called once when the user clicks Download. Resolves to the queue ack;
     *  the actual progress is tracked on the Downloads tab — this card just confirms enqueue. */
    onDownload?: () => Promise<EnqueueResult>
  }

  let {
    title,
    description,
    imageUrl,
    productUrl,
    source,
    hidden,
    bookmarked,
    engineVersions = [],
    onToggleHidden,
    onToggleBookmark,
    onDownload
  }: Props = $props()

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

  let downloadState = $state<DownloadState>({ kind: 'idle' })

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
</script>

<article class:hidden-card={hidden} oncontextmenu={openMenu}>
  <div class="thumb">
    {#if imageUrl}
      <img src={imageUrl} alt="" loading="lazy" />
    {:else}
      <div class="thumb-placeholder">No image</div>
    {/if}
    {#if bookmarked}
      <span class="bookmark-badge" title="Bookmarked">★</span>
    {/if}
    <span class="source-badge source-{source}">{sourceLabel[source]}</span>
  </div>
  <div class="body">
    <h3 {title}>{title}</h3>
    {#if cleanDescription}
      <p class="desc">{cleanDescription}</p>
    {/if}
    {#if engineVersions.length > 0}
      <div class="engine-versions" title="Available engine versions">
        {#each engineVersions as v (v)}
          <span class="ev-chip">{v}</span>
        {/each}
      </div>
    {/if}
  </div>
  <div class="actions">
    {#if productUrl}
      <a href={productUrl} target="_blank" rel="noreferrer">View</a>
    {/if}
    <div class="right-actions">
      {#if onDownload}
        <button
          type="button"
          class="download-btn"
          onclick={handleDownload}
          disabled={downloadState.kind === 'busy' || downloadState.kind === 'queued'}
          title={downloadState.kind === 'queued'
            ? 'Added to the Downloads queue'
            : downloadState.kind === 'error'
              ? downloadState.message
              : 'Add to the Downloads queue'}
        >
          {#if downloadState.kind === 'idle'}Download{/if}
          {#if downloadState.kind === 'busy'}Queuing…{/if}
          {#if downloadState.kind === 'queued'}✓ Queued{/if}
          {#if downloadState.kind === 'error'}✕ Failed (hover){/if}
        </button>
      {/if}
    </div>
  </div>
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
  </div>
{/if}

<style>
  article {
    background: #242424;
    border: 1px solid #333;
    border-radius: 8px;
    overflow: hidden;
    display: flex;
    flex-direction: column;
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

  .desc {
    color: #a0a0a0;
    font-size: 0.8rem;
    margin: 0.4rem 0 0;
    overflow: hidden;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
  }

  .engine-versions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.25rem;
    margin-top: 0.5rem;
  }

  .ev-chip {
    background: #1f1f1f;
    color: #c0c0c0;
    border: 1px solid #2e2e2e;
    border-radius: 3px;
    padding: 0.05rem 0.4rem;
    font-size: 0.7rem;
    font-family: ui-monospace, 'Cascadia Code', Consolas, monospace;
    font-variant-numeric: tabular-nums;
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

  .actions {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 0.5rem 0.9rem 0.75rem;
    font-size: 0.8rem;
    gap: 0.5rem;
  }

  .right-actions {
    display: flex;
    gap: 0.4rem;
    align-items: center;
  }

  .download-btn {
    background: linear-gradient(135deg, rgba(192, 132, 252, 0.15), rgba(244, 114, 182, 0.15));
    color: #d8b4fe;
    border-color: rgba(192, 132, 252, 0.5);
  }

  .download-btn:hover:not(:disabled) {
    background: linear-gradient(135deg, rgba(192, 132, 252, 0.25), rgba(244, 114, 182, 0.25));
    color: #fff;
    border-color: #c084fc;
  }

  .download-btn:disabled {
    opacity: 0.6;
    cursor: progress;
  }

  a {
    color: #c084fc;
    text-decoration: none;
  }

  a:hover {
    text-decoration: underline;
  }

  button {
    background: transparent;
    color: #a0a0a0;
    border: 1px solid #444;
    border-radius: 4px;
    padding: 0.25rem 0.7rem;
    font-size: 0.75rem;
    cursor: pointer;
  }

  button:hover {
    color: #e0e0e0;
    border-color: #666;
  }
</style>
