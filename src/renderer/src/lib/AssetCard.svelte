<script lang="ts">
  type AssetSource = 'vault' | 'fab' | 'legacy'

  interface DownloadResult {
    ok: boolean
    error?: string
    fileCount?: number
    bytesWritten?: number
    durationMs?: number
    dataDir?: string
  }

  interface Props {
    title: string
    description: string | null
    imageUrl: string | null
    productUrl: string | null
    source: AssetSource
    hidden: boolean
    onToggleHidden: () => void
    onDownload?: () => Promise<DownloadResult>
  }

  let {
    title,
    description,
    imageUrl,
    productUrl,
    source,
    hidden,
    onToggleHidden,
    onDownload
  }: Props = $props()

  const sourceLabel: Record<AssetSource, string> = {
    vault: 'Vault',
    fab: 'Fab',
    legacy: 'Legacy'
  }

  type DownloadState =
    | { kind: 'idle' }
    | { kind: 'busy' }
    | { kind: 'done'; fileCount: number; bytesWritten: number; durationMs: number; dataDir: string }
    | { kind: 'error'; message: string }

  let downloadState = $state<DownloadState>({ kind: 'idle' })

  async function handleDownload(): Promise<void> {
    if (!onDownload || downloadState.kind === 'busy') return
    downloadState = { kind: 'busy' }
    try {
      const r = await onDownload()
      if (r.ok) {
        downloadState = {
          kind: 'done',
          fileCount: r.fileCount ?? 0,
          bytesWritten: r.bytesWritten ?? 0,
          durationMs: r.durationMs ?? 0,
          dataDir: r.dataDir ?? ''
        }
      } else {
        downloadState = { kind: 'error', message: r.error ?? 'Download failed' }
      }
    } catch (err) {
      downloadState = { kind: 'error', message: err instanceof Error ? err.message : String(err) }
    }
  }

  function formatBytes(n: number): string {
    if (n < 1024) return n + ' B'
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB'
    if (n < 1024 * 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + ' MB'
    return (n / (1024 * 1024 * 1024)).toFixed(2) + ' GB'
  }
</script>

<article class:hidden-card={hidden}>
  <div class="thumb">
    {#if imageUrl}
      <img src={imageUrl} alt="" loading="lazy" />
    {:else}
      <div class="thumb-placeholder">No image</div>
    {/if}
    <span class="source-badge source-{source}">{sourceLabel[source]}</span>
  </div>
  <div class="body">
    <h3 {title}>{title}</h3>
    {#if description}
      <p class="desc">{description}</p>
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
          disabled={downloadState.kind === 'busy'}
          title={downloadState.kind === 'done' ? `Saved to ${downloadState.dataDir}` : downloadState.kind === 'error' ? downloadState.message : 'Download this asset'}
        >
          {#if downloadState.kind === 'idle'}↓ Download{/if}
          {#if downloadState.kind === 'busy'}Downloading…{/if}
          {#if downloadState.kind === 'done'}✓ {downloadState.fileCount} files, {formatBytes(downloadState.bytesWritten)}{/if}
          {#if downloadState.kind === 'error'}✕ Failed (hover){/if}
        </button>
      {/if}
      <button type="button" onclick={onToggleHidden}>
        {hidden ? 'Show in library' : 'Hide'}
      </button>
    </div>
  </div>
</article>

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
