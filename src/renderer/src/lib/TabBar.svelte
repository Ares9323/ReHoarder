<script lang="ts">
  import type { TabKey } from './tabs'

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

  const tabs: TabDef[] = [
    { key: 'assets', label: 'Assets' },
    { key: 'engines', label: 'Engines' },
    { key: 'projects', label: 'Projects' },
    { key: 'vault', label: 'Vault' },
    { key: 'settings', label: 'Settings' },
    { key: 'downloads', label: 'Downloads' }
  ]
</script>

<nav class="tab-bar">
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
    font-size: 0.95rem;
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
