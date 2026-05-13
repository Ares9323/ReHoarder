import { ipcMain } from 'electron'
import type { AppSettings, SettingsStore } from './settings'

export function registerSettingsIpc(store: SettingsStore): void {
  ipcMain.handle('settings:get', async (): Promise<AppSettings> => {
    return store.load()
  })

  ipcMain.handle(
    'settings:set',
    async (_e, partial: Partial<AppSettings>): Promise<AppSettings> => {
      return store.saveAll(partial)
    }
  )
}
