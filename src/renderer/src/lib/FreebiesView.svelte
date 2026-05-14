<script lang="ts">
  import { onMount } from 'svelte'
  import { freebiesStore } from '../stores/freebies.svelte'

  const freebies = $derived(freebiesStore.freebies)
  const loading = $derived(freebiesStore.loading)
  const error = $derived(freebiesStore.error)
  const fetchedAt = $derived(freebiesStore.fetchedAt)
  const unclaimed = $derived(freebiesStore.unclaimedCount)

  onMount(() => {
    void freebiesStore.ensureLoaded()
  })

  /** Open the listing on fab.com in the user's default browser, where the
   *  actual claim/Add-to-library flow lives. */
  function claimOnFab(url: string): void {
    void window.open(url, '_blank', 'noopener')
  }

  function formatTime(ms: number | null): string {
    if (ms === null) return '—'
    return new Date(ms).toLocaleString()
  }
</script>

<section>
  <header class="bar">
    <div class="lead">
      <h2>Free for the Month</h2>
      <p class="explain">
        Fab's current month freebies. Cards marked <strong>Claimed</strong> are already in your
        library — the rest are one click away on fab.com.
      </p>
    </div>
    <div class="stats">
      {#if freebies.length > 0}
        <span>{freebies.length} freebie{freebies.length === 1 ? '' : 's'}</span>
        <span>·</span>
        <span class:hot={unclaimed > 0}>{unclaimed} unclaimed</span>
        {#if fetchedAt !== null}
          <span class="hint">checked at {formatTime(fetchedAt)}</span>
        {/if}
      {/if}
      <button type="button" onclick={() => freebiesStore.refresh()} disabled={loading}>
        {loading ? 'Loading…' : 'Refresh'}
      </button>
    </div>
  </header>

  {#if loading && freebies.length === 0}
    <div class="state">Loading freebies…</div>
  {:else if error}
    <div class="state err">{error}</div>
  {:else if freebies.length === 0}
    <div class="state empty">
      No freebies found right now. Fab usually publishes the new batch on the first Tuesday
      of every month — check back then.
    </div>
  {:else}
    <div class="grid">
      {#each freebies as f (f.uid || f.title)}
        <article class="card" class:claimed={f.claimed === true}>
          <div class="thumb">
            {#if f.imageUrl}
              <img src={f.imageUrl} alt={f.title} loading="lazy" />
            {:else}
              <div class="thumb-placeholder">no image</div>
            {/if}
            {#if f.claimed === true}
              <span class="badge claimed-badge" title="Already in your library">✓ Claimed</span>
            {:else if f.claimed === false}
              <span class="badge new-badge" title="Not in your library yet">New</span>
            {/if}
          </div>
          <div class="body">
            <h3 class="title" title={f.title}>{f.title}</h3>
            <button type="button" class="claim" onclick={() => claimOnFab(f.productUrl)}>
              {f.claimed === true ? 'Open on Fab' : 'Claim on Fab'}
            </button>
          </div>
        </article>
      {/each}
    </div>
  {/if}
</section>

<style>
  section {
    padding: 1.5rem;
    max-width: 1400px;
    margin: 0 auto;
  }
  .bar {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 1rem;
    margin-bottom: 1.5rem;
    flex-wrap: wrap;
  }
  .lead h2 {
    margin: 0 0 0.3rem;
    color: #fff;
    font-size: 1.15rem;
  }
  .explain {
    color: #888;
    font-size: 0.85rem;
    margin: 0;
    max-width: 720px;
  }
  .stats {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    color: #b0b0b0;
    font-size: 0.85rem;
    flex-wrap: wrap;
  }
  .stats .hint {
    color: #666;
    font-size: 0.75rem;
  }
  .stats .hot {
    color: #c084fc;
    font-weight: 600;
  }
  .stats button {
    margin-left: 0.5rem;
    background: transparent;
    color: #c0c0c0;
    border: 1px solid #444;
    border-radius: 4px;
    padding: 0.3rem 0.7rem;
    font-size: 0.75rem;
    font-family: inherit;
    cursor: pointer;
  }
  .stats button:hover:not(:disabled) {
    color: #fff;
    border-color: #666;
  }
  .stats button:disabled {
    opacity: 0.5;
    cursor: progress;
  }
  .state {
    background: #242424;
    border: 1px solid #333;
    border-radius: 8px;
    padding: 2rem;
    text-align: center;
    color: #888;
  }
  .state.err {
    color: #fca5a5;
    border-color: #663030;
  }
  .state.empty {
    color: #888;
  }
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
    gap: 1rem;
  }
  .card {
    background: #242424;
    border: 1px solid #333;
    border-radius: 8px;
    overflow: hidden;
    display: flex;
    flex-direction: column;
  }
  .card.claimed {
    opacity: 0.72;
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
    width: 100%;
    height: 100%;
    display: flex;
    align-items: center;
    justify-content: center;
    color: #555;
    font-size: 0.75rem;
  }
  .badge {
    position: absolute;
    top: 0.5rem;
    right: 0.5rem;
    padding: 0.2rem 0.55rem;
    border-radius: 999px;
    font-size: 0.7rem;
    font-weight: 700;
    color: #fff;
  }
  .claimed-badge {
    background: #166534;
  }
  .new-badge {
    background: linear-gradient(135deg, #c084fc, #f472b6);
  }
  .body {
    padding: 0.7rem 0.85rem 0.85rem;
    display: flex;
    flex-direction: column;
    gap: 0.55rem;
    flex: 1;
  }
  .title {
    margin: 0;
    color: #e0e0e0;
    font-size: 0.9rem;
    font-weight: 500;
    line-height: 1.25;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .claim {
    margin-top: auto;
    background: linear-gradient(135deg, #c084fc, #f472b6);
    color: #fff;
    border: none;
    border-radius: 5px;
    padding: 0.4rem 0.8rem;
    font-size: 0.8rem;
    font-family: inherit;
    cursor: pointer;
    font-weight: 500;
  }
  .card.claimed .claim {
    background: transparent;
    border: 1px solid #555;
    color: #c0c0c0;
  }
  .claim:hover:not(:disabled) {
    filter: brightness(1.08);
  }
</style>
