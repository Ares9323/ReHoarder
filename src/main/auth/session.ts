import { EventEmitter } from 'node:events'
import { OAuthClient, OAuthError } from './oauth-client'
import type { SecureTokenStorage } from './secure-storage'
import type { AccountsRepo } from '../db/accounts-repo'
import {
  tokensFromOAuthResponse,
  isAccessTokenExpired,
  isRefreshTokenExpired,
  type Tokens
} from './tokens'

export type AuthState =
  | { status: 'anonymous' }
  | { status: 'authenticated'; accountId: string; displayName: string }

export interface AccountSummary {
  accountId: string
  displayName: string
  /** True for the currently active account (the one whose tokens back library queries). */
  active: boolean
  /** True when the account row exists (so we still know the display name) but
   *  the refresh token has been dropped (failed refresh, manual clear, encrypted
   *  blob unreadable on startup). The switcher can't `switchTo` such an account
   *  — instead it should route the click into the re-login flow. */
  signedOut: boolean
}

/**
 * Multi-account session. Holds an in-memory `Map<accountId, Tokens>` of every
 * Epic account that has valid (refresh-able) credentials, plus a single
 * "active" pointer. Switching account flips the active pointer, refreshes the
 * access token if needed and broadcasts a `state-changed` event that the
 * renderer uses to reload its per-account stores.
 *
 * The on-disk token storage is per-account via `SecureTokenStorage`. The
 * `accounts` table (via `AccountsRepo`) tracks display names and the active
 * id; it persists across launches even if the in-memory map drops (e.g. when
 * a refresh fails on init we keep the row so the user can re-login it).
 */
export class Session extends EventEmitter {
  private tokensByAccount = new Map<string, Tokens>()
  private activeId: string | null = null

  constructor(
    private readonly storage: SecureTokenStorage,
    private readonly accountsRepo: AccountsRepo,
    private readonly client: OAuthClient
  ) {
    super()
  }

  getState(): AuthState {
    if (this.activeId === null) return { status: 'anonymous' }
    const account = this.accountsRepo.findById(this.activeId)
    if (!account) return { status: 'anonymous' }
    return {
      status: 'authenticated',
      accountId: account.id,
      displayName: account.displayName
    }
  }

  getAccessToken(): string | null {
    if (this.activeId === null) return null
    return this.tokensByAccount.get(this.activeId)?.accessToken ?? null
  }

  /** Snapshot of every account known to the repo. Accounts whose tokens
   *  are no longer loaded (refresh expired, decrypt failure, manually
   *  cleared) are flagged `signedOut: true` instead of being hidden, so
   *  the switcher can offer a re-login affordance. */
  listAccounts(): AccountSummary[] {
    return this.accountsRepo.list().map((a) => ({
      accountId: a.id,
      displayName: a.displayName,
      active: a.id === this.activeId,
      signedOut: !this.tokensByAccount.has(a.id)
    }))
  }

  /**
   * Load every persisted account, refresh expired access tokens, and pick an
   * active one. Order of operations:
   *   1. Migrate the legacy `auth.tokens` slot (single-account era) into its
   *      per-account slot, and rebind every `account_id = 'legacy'` row in the
   *      scoped tables to the real Epic account id.
   *   2. For each account id known to storage, load tokens; drop the ones
   *      whose refresh token has expired (user needs to log in again).
   *   3. Verify each account against `/account/api/oauth/verify` and upsert
   *      the resulting display name into `accounts`.
   *   4. Choose active: kv pointer if it still resolves, else the most
   *      recently used account, else anonymous.
   */
  async init(): Promise<void> {
    const migratedId = this.storage.migrateLegacySlot()
    if (migratedId !== null) {
      // We don't have the display name yet — `verify()` below will fill it in.
      // Stamp a placeholder so the rebind has something to point at, then
      // rebind the legacy rows. The verify pass will overwrite display_name.
      this.accountsRepo.upsert(migratedId, 'Epic account')
      const moved = this.accountsRepo.rebindLegacyTo(migratedId, 'Epic account')
      console.warn(
        `[auth] migrated legacy token slot to account ${migratedId} (rebound ${moved} asset rows)`
      )
    }

    const ids = this.storage.listAccountIds()
    for (const id of ids) {
      const tokens = this.storage.load(id)
      if (tokens === null) continue
      if (isRefreshTokenExpired(tokens)) {
        console.warn(`[auth] init: refresh token expired for ${id}, clearing`)
        this.storage.clear(id)
        continue
      }
      let working = tokens
      if (isAccessTokenExpired(working)) {
        try {
          working = await this.doRefresh(working.refreshToken)
        } catch (err) {
          console.warn(
            `[auth] init: refresh failed for ${id}: ${err instanceof Error ? err.message : err}`
          )
          this.storage.clear(id)
          continue
        }
      }
      try {
        const profile = await this.client.verify(working.accessToken)
        this.accountsRepo.upsert(profile.account_id, profile.display_name)
        this.tokensByAccount.set(profile.account_id, working)
      } catch (err) {
        console.warn(
          `[auth] init: verify failed for ${id}: ${err instanceof Error ? err.message : err}`
        )
        this.storage.clear(id)
      }
    }

    // Pick the active account: the persisted pointer wins when it resolves,
    // otherwise fall back to the most-recently-used row with valid tokens.
    const persisted = this.accountsRepo.getActiveId()
    if (persisted !== null && this.tokensByAccount.has(persisted)) {
      this.activeId = persisted
    } else {
      const candidates = this.accountsRepo
        .list()
        .filter((a) => this.tokensByAccount.has(a.id))
      this.activeId = candidates.length > 0 ? candidates[0].id : null
      if (this.activeId !== null) this.accountsRepo.setActiveId(this.activeId)
    }
    this.publishState()
    this.publishAccountsChanged()
  }

  /**
   * Add (or replace) an account from a freshly-issued authorization code.
   * The new account is automatically made active. Returns the resolved
   * account id so the caller can hook anything else off it.
   */
  async exchangeCode(code: string): Promise<string> {
    const response = await this.client.exchangeCode(code)
    const tokens = tokensFromOAuthResponse(response)
    this.storage.save(tokens)
    const profile = await this.client.verify(tokens.accessToken)
    this.accountsRepo.upsert(profile.account_id, profile.display_name)
    this.tokensByAccount.set(profile.account_id, tokens)
    this.activeId = profile.account_id
    this.accountsRepo.setActiveId(profile.account_id)
    this.publishState()
    this.publishAccountsChanged()
    return profile.account_id
  }

  /**
   * Switch the active account. Refreshes the access token if it's near
   * expiry. Throws when `accountId` isn't an authenticated account (caller
   * should already have validated via `listAccounts()`).
   */
  async switchTo(accountId: string): Promise<void> {
    if (!this.tokensByAccount.has(accountId)) {
      throw new Error(`Unknown or signed-out account: ${accountId}`)
    }
    let tokens = this.tokensByAccount.get(accountId)!
    if (isAccessTokenExpired(tokens)) {
      try {
        tokens = await this.doRefresh(tokens.refreshToken)
      } catch (err) {
        // Refresh failed → treat as logged-out. Drop the account from memory
        // but keep the accounts row so the user can re-login it.
        this.tokensByAccount.delete(accountId)
        this.storage.clear(accountId)
        this.publishAccountsChanged()
        throw err
      }
    }
    this.activeId = accountId
    this.accountsRepo.setActiveId(accountId)
    this.publishState()
    this.publishAccountsChanged()
  }

  /**
   * Sign out and forget an account. Tokens are cleared; the accounts row is
   * removed; per-account data in scoped tables is wiped (assets, asset_tags,
   * sync_state, downloads). If the removed account was active, the next
   * most-recently-used authenticated account becomes active — or, if there
   * are none, we drop to anonymous.
   */
  async removeAccount(accountId: string): Promise<void> {
    this.tokensByAccount.delete(accountId)
    this.storage.clear(accountId)
    this.accountsRepo.wipeAccountData(accountId)
    this.accountsRepo.remove(accountId)
    if (this.activeId === accountId) {
      const next = this.accountsRepo
        .list()
        .find((a) => this.tokensByAccount.has(a.id))
      this.activeId = next ? next.id : null
      if (this.activeId !== null) this.accountsRepo.setActiveId(this.activeId)
      else this.accountsRepo.setActiveId(null)
    }
    this.publishState()
    this.publishAccountsChanged()
  }

  /** Legacy single-account "sign out": removes only the currently active account. */
  async logout(): Promise<void> {
    if (this.activeId !== null) {
      await this.removeAccount(this.activeId)
    }
  }

  private async doRefresh(refreshToken: string): Promise<Tokens> {
    const response = await this.client.refresh(refreshToken)
    const tokens = tokensFromOAuthResponse(response)
    this.storage.save(tokens)
    this.tokensByAccount.set(tokens.accountId, tokens)
    return tokens
  }

  private publishState(): void {
    this.emit('state-changed', this.getState())
  }

  private publishAccountsChanged(): void {
    this.emit('accounts-changed', this.listAccounts())
  }
}

export { OAuthError }
