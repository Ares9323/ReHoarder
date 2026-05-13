<script lang="ts">
  type AssetSource = 'vault' | 'fab' | 'legacy'

  interface Props {
    title: string
    description: string | null
    imageUrl: string | null
    productUrl: string | null
    source: AssetSource
    hidden: boolean
    onToggleHidden: () => void
  }

  let { title, description, imageUrl, productUrl, source, hidden, onToggleHidden }: Props = $props()

  const sourceLabel: Record<AssetSource, string> = {
    vault: 'Vault',
    fab: 'Fab',
    legacy: 'Legacy'
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
    <button type="button" onclick={onToggleHidden}>
      {hidden ? 'Show in library' : 'Hide'}
    </button>
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
