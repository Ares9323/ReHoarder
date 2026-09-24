import { ipcMain } from 'electron'
import type { FabWebSession, FabWebStatus } from './fab-web-session'

/**
 * `fab:web-status`: current fab.com web session status (in-page probe).
 * `fab:web-login`: interactive login ("Sign in to Fab" window as fallback).
 */
export function registerFabWebIpc(web: FabWebSession): void {
  ipcMain.handle('fab:web-status', (): Promise<FabWebStatus> => web.checkStatus())
  ipcMain.handle(
    'fab:web-login',
    (): Promise<FabWebStatus> =>
      web.ensureLoggedIn({
        interactive: true,
        onLog: (line) => console.warn(`[fab-web] ${line}`)
      })
  )
}
