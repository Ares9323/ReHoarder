<script lang="ts">
  import { onMount } from 'svelte'
  import type { TabKey } from './tabs'
  import { downloadsStore } from '../stores/downloads.svelte'
  import { freebiesStore } from '../stores/freebies.svelte'

  interface TabDef {
    key: TabKey
    label: string
  }

  interface Props {
    active: TabKey
    onChange: (key: TabKey) => void
    onSignOut?: () => void
  }

  let { active, onChange, onSignOut }: Props = $props()

  // Live count of queued+running downloads, surfaced as a chip next to the
  // Downloads tab. Derived off the singleton store — no per-mount IPC.
  const activeDownloads = $derived(
    downloadsStore.all.filter((d) => d.status === 'queued' || d.status === 'running').length
  )
  // Unclaimed freebies show as a chip on the Freebies tab. The store keeps
  // its own loading lifecycle — we just read the derived count.
  const unclaimedFreebies = $derived(freebiesStore.unclaimedCount)

  onMount(() => {
    void downloadsStore.ensureLoaded()
  })

  /**
   * Track our own rendered height so other sticky elements (the Assets filter
   * row) can align flush below us without hardcoding a magic offset that drifts
   * when fonts/padding change. Published as a CSS variable on `<html>`.
   */
  let height = $state(0)
  $effect(() => {
    document.documentElement.style.setProperty('--tab-bar-height', `${height}px`)
  })

  const tabs: TabDef[] = [
    { key: 'assets', label: 'Assets' },
    { key: 'projects', label: 'Projects' },
    { key: 'engines', label: 'Engines' },
    { key: 'vault', label: 'Vault' },
    { key: 'freebies', label: 'Freebies' },
    { key: 'settings', label: 'Settings' },
    { key: 'downloads', label: 'Downloads' }
  ]
</script>

<nav class="tab-bar" bind:clientHeight={height}>
  <div class="brand">ReHoarder</div>
  <div class="tabs">
    {#each tabs as t (t.key)}
      <button
        type="button"
        class="tab"
        class:active={active === t.key}
        onclick={() => onChange(t.key)}
      >
        {t.label}
        {#if t.key === 'downloads' && activeDownloads > 0}
          <span class="badge" title="{activeDownloads} download{activeDownloads === 1 ? '' : 's'} in progress">
            {activeDownloads}
          </span>
        {/if}
        {#if t.key === 'freebies' && unclaimedFreebies > 0}
          <span class="badge" title="{unclaimedFreebies} freebie{unclaimedFreebies === 1 ? '' : 's'} you haven't claimed yet">
            {unclaimedFreebies}
          </span>
        {/if}
      </button>
    {/each}
  </div>
  {#if onSignOut}
    <button type="button" class="signout" onclick={() => onSignOut()}>Sign out</button>
  {/if}
</nav>

<style>
  .tab-bar {
    position: sticky;
    top: 0;
    z-index: 10;
    background: #1a1a1a;
    border-bottom: 1px solid #2a2a2a;
    display: flex;
    align-items: stretch;
    padding: 0 1rem;
    gap: 1.5rem;
  }

  .brand {
    align-self: center;
    font-weight: 700;
    font-size: 1.25rem;
    background: linear-gradient(135deg, #c084fc, #f472b6);
    -webkit-background-clip: text;
    background-clip: text;
    color: transparent;
    letter-spacing: 0.02em;
  }

  .tabs {
    display: flex;
    gap: 0.1rem;
    flex: 1;
  }

  .tab {
    background: transparent;
    color: #a0a0a0;
    border: none;
    border-bottom: 2px solid transparent;
    padding: 0.85rem 1.1rem;
    font-size: 0.9rem;
    font-family: inherit;
    cursor: pointer;
    transition: color 0.12s, border-color 0.12s;
  }

  .tab:hover {
    color: #d8d8d8;
  }

  .tab.active {
    color: #fff;
    border-bottom-color: #c084fc;
  }

  .badge {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 1.25rem;
    height: 1.25rem;
    padding: 0 0.4rem;
    margin-left: 0.45rem;
    border-radius: 999px;
    background: linear-gradient(135deg, #c084fc, #f472b6);
    color: white;
    font-size: 0.7rem;
    font-weight: 700;
    line-height: 1;
    font-variant-numeric: tabular-nums;
  }

  .signout {
    align-self: center;
    background: transparent;
    color: #888;
    border: 1px solid #333;
    border-radius: 4px;
    padding: 0.3rem 0.8rem;
    font-size: 0.75rem;
    font-family: inherit;
    cursor: pointer;
  }

  .signout:hover {
    color: #ccc;
    border-color: #555;
  }
</style>
