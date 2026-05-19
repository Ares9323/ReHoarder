import { ipcMain, shell, session as electronSession } from 'electron'
import { buildEpicLoginUrl } from './epic-credentials'
import type { Session, AccountSummary } from './session'

/**
 * Reset every cookie in the CF-warmup partition. Fab `fab_sessionid` /
 * Epic identity cookies for the previous account would otherwise leak into
 * the next account's first sync and silently authenticate as the wrong
 * user. The cost is one extra Cloudflare warmup on the next sync (~3 s);
 * cheaper than rolling per-account partitions for v1.
 */
async function resetCfPartition(partition: string): Promise<void> {
  try {
    const sess = electronSession.fromPartition(partition)
    // The Electron docs say clearStorageData accepts {storages: ['cookies']}
    // — that's the narrowest reset that still drops everything Fab cares
    // about. We avoid `clearCache()` because the cf-warmup cache feeds
    // back into the navigation behaviour and shouldn't churn on switch.
    await sess.clearStorageData({ storages: ['cookies'] })
  } catch (err) {
    console.warn('[accounts] failed to reset CF partition cookies:', err)
  }
}

export interface AccountSwitchResult {
  ok: boolean
  error?: string
}

/**
 * IPC for the multi-account switcher. Login itself still flows through the
 * existing `auth:start-login` + `auth:submit-code` pair — those return the
 * code which `Session.exchangeCode()` then turns into a NEW account when
 * the verified `account_id` is different from any we already have.
 *
 * The renderer subscribes to `accounts:changed` to refresh its store after
 * every add/remove/switch.
 */
export function registerAccountsIpc(
  session: Session,
  broadcastAccounts: (accounts: AccountSummary[]) => void,
  cfPartition: string = 'persist:cf-warmup'
): void {
  ipcMain.handle('accounts:list', (): AccountSummary[] => session.listAccounts())

  ipcMain.handle(
    'accounts:switch',
    async (_e, accountId: string): Promise<AccountSwitchResult> => {
      try {
        await session.switchTo(accountId)
        await resetCfPartition(cfPartition)
        return { ok: true }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    }
  )

  ipcMain.handle('accounts:remove', async (_e, accountId: string): Promise<void> => {
    await session.removeAccount(accountId)
    await resetCfPartition(cfPartition)
  })

  /** Open the Epic login page in the user's default browser. The renderer
   *  then prompts for the authorization code and feeds it back via
   *  `auth:submit-code` — the new account is added in `Session.exchangeCode`. */
  ipcMain.handle('accounts:add-login', async (): Promise<void> => {
    await shell.openExternal(buildEpicLoginUrl())
  })

  session.on('accounts-changed', (accounts: AccountSummary[]) => broadcastAccounts(accounts))
}
