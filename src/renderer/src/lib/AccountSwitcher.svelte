<script lang="ts">
  import { onMount } from 'svelte'
  import { accountsStore } from '../stores/accounts.svelte'

  interface Props {
    /** Fires when the active account changes (the switcher already kicked
     *  off `accounts.switchTo` — callers use this hook to reload per-account
     *  renderer stores). */
    onSwitched?: (accountId: string) => void
    /** Triggered by "Add account…" — opens the Epic login in the browser
     *  AND switches the parent App into the LoginView so the user can paste
     *  the code returned from the OAuth callback. */
    onAddAccount?: () => void
  }

  let { onSwitched, onAddAccount }: Props = $props()

  let open = $state(false)
  let menuEl = $state<HTMLDivElement | null>(null)

  onMount(() => {
    void accountsStore.refresh()
    const onDocClick = (e: MouseEvent): void => {
      if (!open) return
      const target = e.target as Node
      if (menuEl && !menuEl.contains(target)) open = false
    }
    document.addEventListener('mousedown', onDocClick)
    return () => document.removeEventListener('mousedown', onDocClick)
  })

  const active = $derived(accountsStore.active)
  const others = $derived(accountsStore.accounts.filter((a) => !a.active))

  async function switchTo(accountId: string): Promise<void> {
    open = false
    const ok = await accountsStore.switchTo(accountId)
    if (ok) onSwitched?.(accountId)
  }

  /** Signed-out accounts have a row in the DB but no usable tokens — clicking
   *  them routes to the same Add-account flow so the user can paste a fresh
   *  OAuth code, which then re-links the account by id. */
  function relink(): void {
    startAddAccount()
  }

  async function remove(accountId: string, ev: MouseEvent): Promise<void> {
    ev.stopPropagation()
    if (
      !window.confirm(
        'Sign out and remove this account? Library, bookmarks and download history for this account will be deleted from this device.'
      )
    ) {
      return
    }
    open = false
    await accountsStore.remove(accountId)
  }

  function startAddAccount(): void {
    open = false
    void accountsStore.addLogin()
    onAddAccount?.()
  }

  function initials(name: string): string {
    return name
      .trim()
      .split(/\s+/)
      .map((part) => part[0]?.toUpperCase() ?? '')
      .slice(0, 2)
      .join('')
  }
</script>

<div class="switcher" bind:this={menuEl}>
  {#if active}
    <button type="button" class="trigger" onclick={() => (open = !open)} aria-haspopup="menu">
      <span class="avatar">{initials(active.displayName)}</span>
      <span class="name">{active.displayName}</span>
      <span class="chev" class:up={open}>▾</span>
    </button>
  {/if}

  {#if open}
    <div class="menu" role="menu">
      {#if others.length > 0}
        <div class="section-label">Switch to</div>
        {#each others as a (a.accountId)}
          <div class="row" class:signed-out={a.signedOut}>
            <button
              type="button"
              class="item switchable"
              class:relink={a.signedOut}
              onclick={() => (a.signedOut ? relink() : switchTo(a.accountId))}
              disabled={accountsStore.busy}
              title={a.signedOut
                ? 'Session expired — click to re-link this account with a fresh login'
                : `Switch to ${a.displayName}`}
            >
              <span class="avatar small">{initials(a.displayName)}</span>
              <span class="item-name">{a.displayName}</span>
              {#if a.signedOut}
                <span class="badge">re-link</span>
              {/if}
            </button>
            <button
              type="button"
              class="remove"
              title="Sign out this account"
              onclick={(e) => remove(a.accountId, e)}
              disabled={accountsStore.busy}
            >×</button>
          </div>
        {/each}
        <div class="sep"></div>
      {/if}
      <button type="button" class="item add" onclick={startAddAccount} disabled={accountsStore.busy}>
        + Add account…
      </button>
      {#if active}
        <button
          type="button"
          class="item danger"
          onclick={(e) => remove(active.accountId, e)}
          disabled={accountsStore.busy}
        >
          Sign out {active.displayName}
        </button>
      {/if}
      {#if accountsStore.error}
        <div class="error">{accountsStore.error}</div>
      {/if}
    </div>
  {/if}
</div>

<style>
  .switcher {
    position: relative;
    align-self: center;
    margin-left: auto;
  }
  .trigger {
    display: inline-flex;
    align-items: center;
    gap: 0.45rem;
    background: transparent;
    color: #d8d8d8;
    border: 1px solid #333;
    border-radius: 6px;
    padding: 0.3rem 0.55rem 0.3rem 0.4rem;
    font-size: 0.82rem;
    font-family: inherit;
    cursor: pointer;
  }
  .trigger:hover {
    border-color: #555;
    color: #fff;
  }
  .avatar {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 1.55rem;
    height: 1.55rem;
    border-radius: 999px;
    background: linear-gradient(135deg, #c084fc, #f472b6);
    color: #fff;
    font-size: 0.7rem;
    font-weight: 700;
    line-height: 1;
  }
  .avatar.small {
    width: 1.3rem;
    height: 1.3rem;
    font-size: 0.6rem;
  }
  .name {
    max-width: 12rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .chev {
    color: #888;
    font-size: 0.7rem;
    transition: transform 0.12s;
  }
  .chev.up {
    transform: rotate(180deg);
  }
  .menu {
    position: absolute;
    top: calc(100% + 0.3rem);
    right: 0;
    z-index: 50;
    min-width: 16rem;
    background: #1f1f1f;
    border: 1px solid #333;
    border-radius: 6px;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.55);
    padding: 0.3rem;
    display: flex;
    flex-direction: column;
    gap: 0.05rem;
  }
  .section-label {
    color: #888;
    font-size: 0.7rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    padding: 0.4rem 0.5rem 0.2rem 0.5rem;
  }
  .item {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    background: transparent;
    color: #ddd;
    border: none;
    border-radius: 4px;
    padding: 0.45rem 0.5rem;
    font-size: 0.82rem;
    font-family: inherit;
    cursor: pointer;
    text-align: left;
  }
  .item:hover:not(:disabled) {
    background: #2a2a2a;
    color: #fff;
  }
  .item:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .item-name {
    flex: 1;
  }
  .row {
    display: flex;
    align-items: stretch;
    gap: 0.1rem;
  }
  .row .item {
    flex: 1;
  }
  .row.signed-out .avatar,
  .row.signed-out .item-name {
    opacity: 0.55;
  }
  .item.relink .badge {
    margin-left: auto;
    padding: 0.05rem 0.4rem;
    border: 1px solid #c084fc;
    border-radius: 999px;
    color: #c084fc;
    font-size: 0.65rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  .item.relink:hover:not(:disabled) {
    background: #2a213a;
  }
  .remove {
    background: transparent;
    color: #777;
    border: none;
    border-radius: 4px;
    font-size: 1rem;
    line-height: 1;
    padding: 0 0.45rem;
    cursor: pointer;
  }
  .remove:hover:not(:disabled) {
    color: #f472b6;
    background: #2a2a2a;
  }
  .remove:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }
  .item.add {
    color: #c084fc;
  }
  .item.danger {
    color: #f87171;
  }
  .sep {
    height: 1px;
    background: #2e2e2e;
    margin: 0.2rem 0;
  }
  .error {
    padding: 0.4rem 0.5rem;
    color: #fca5a5;
    font-size: 0.75rem;
  }
</style>
