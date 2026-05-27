interface AccountSummary {
  accountId: string
  displayName: string
  active: boolean
  /** True when the row exists but tokens are gone — switcher routes the
   *  click into the re-login flow instead of `switchTo`. */
  signedOut: boolean
}

let accounts = $state<AccountSummary[]>([])
let busy = $state(false)
let error = $state<string | null>(null)

window.api.accounts.onChanged((next) => {
  accounts = next
})

/**
 * Singleton store backing the AccountSwitcher dropdown. Mirrors the active
 * Epic-account list maintained by the main process; subscribes to
 * `accounts:changed` so add/remove/switch operations update the list
 * without polling. `switchTo()` triggers per-account stores (library,
 * freebies, downloads) to reload via the `auth:state-changed` event the
 * main process emits right after.
 */
export const accountsStore = {
  get accounts(): AccountSummary[] {
    return accounts
  },
  get active(): AccountSummary | null {
    return accounts.find((a) => a.active) ?? null
  },
  get busy(): boolean {
    return busy
  },
  get error(): string | null {
    return error
  },
  async refresh(): Promise<void> {
    accounts = await window.api.accounts.list()
  },
  async switchTo(accountId: string): Promise<boolean> {
    busy = true
    error = null
    try {
      const r = await window.api.accounts.switchTo(accountId)
      if (!r.ok) {
        error = r.error ?? 'Failed to switch account'
        return false
      }
      return true
    } finally {
      busy = false
    }
  },
  async remove(accountId: string): Promise<void> {
    busy = true
    try {
      await window.api.accounts.remove(accountId)
    } finally {
      busy = false
    }
  },
  async addLogin(): Promise<void> {
    busy = true
    try {
      await window.api.accounts.addLogin()
    } finally {
      busy = false
    }
  }
}
