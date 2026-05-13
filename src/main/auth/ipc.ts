import { ipcMain, shell } from 'electron'
import { buildEpicLoginUrl } from './epic-credentials'
import type { Session, AuthState } from './session'
import { OAuthError } from './oauth-client'

export interface SubmitCodeResult {
  ok: boolean
  error?: { code: string; message: string }
}

export function registerAuthIpc(session: Session, broadcastState: (s: AuthState) => void): void {
  ipcMain.handle('auth:get-state', (): AuthState => session.getState())

  ipcMain.handle('auth:start-login', async (): Promise<void> => {
    await shell.openExternal(buildEpicLoginUrl())
  })

  ipcMain.handle('auth:submit-code', async (_e, code: string): Promise<SubmitCodeResult> => {
    try {
      await session.exchangeCode(code)
      return { ok: true }
    } catch (err) {
      if (err instanceof OAuthError) {
        return {
          ok: false,
          error: {
            code: err.errorCode ?? `http_${err.status}`,
            message: err.errorMessage ?? err.message
          }
        }
      }
      return {
        ok: false,
        error: { code: 'unknown', message: err instanceof Error ? err.message : String(err) }
      }
    }
  })

  ipcMain.handle('auth:logout', async (): Promise<void> => {
    await session.logout()
  })

  session.on('state-changed', (state: AuthState) => broadcastState(state))
}
