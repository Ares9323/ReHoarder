import { ipcMain } from 'electron'
import type { AppSettings, SettingsStore } from './settings'

export interface SettingsIpcDeps {
  /** Fired after every `settings:set` write. Subscribers (e.g. the downloads
   *  manager) can react synchronously to the new config — typical use is
   *  re-pumping work queues when a limit-style setting got bigger. */
  onChange?: (next: AppSettings) => void
}

export function registerSettingsIpc(store: SettingsStore, deps: SettingsIpcDeps = {}): void {
  ipcMain.handle('settings:get', async (): Promise<AppSettings> => {
    return store.load()
  })

  ipcMain.handle(
    'settings:set',
    async (_e, partial: Partial<AppSettings>): Promise<AppSettings> => {
      const next = store.saveAll(partial)
      deps.onChange?.(next)
      return next
    }
  )
}
