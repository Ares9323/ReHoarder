import { ipcMain, type BrowserWindow } from 'electron'
import type { AssetsRepo, AssetSource } from '../db/assets-repo'
import type { Sync, SyncProgress } from './sync'
import type { Session } from '../auth/session'

export interface LibraryQuery {
  source?: AssetSource
  subSource?: 'fab-ue' | 'fab-other'
  search?: string
  includeHidden?: boolean
  onlyHidden?: boolean
  onlyBookmarked?: boolean
}

export interface LibraryListResult {
  assets: ReturnType<AssetsRepo['list']>
  countsBySource: Record<string, number>
  lastSync: Record<string, { at: number; status: string; error: string | null }>
}

export function registerLibraryIpc(
  repo: AssetsRepo,
  sync: Sync,
  session: Session,
  getMainWindow: () => BrowserWindow | null
): void {
  ipcMain.handle('library:list', (_e, query: LibraryQuery): LibraryListResult => {
    return {
      assets: repo.list(query),
      countsBySource: repo.countBySource(),
      lastSync: sync.getLastSyncState()
    }
  })

  ipcMain.handle(
    'library:set-hidden',
    (_e, source: AssetSource, sourceId: string, hidden: boolean): void => {
      repo.setHidden(source, sourceId, hidden)
    }
  )

  ipcMain.handle(
    'library:set-bookmarked',
    (_e, source: AssetSource, sourceId: string, bookmarked: boolean): void => {
      repo.setBookmarked(source, sourceId, bookmarked)
    }
  )

  ipcMain.handle('library:sync', async (): Promise<{ ok: boolean; error?: string }> => {
    const token = session.getAccessToken()
    const state = session.getState()
    if (token === null || state.status !== 'authenticated') {
      return { ok: false, error: 'Not authenticated.' }
    }

    const sendProgress = (p: SyncProgress): void => {
      const win = getMainWindow()
      if (win && !win.isDestroyed()) {
        win.webContents.send('library:sync-progress', p)
      }
    }

    const sendLog = (line: string): void => {
      const win = getMainWindow()
      if (win && !win.isDestroyed()) {
        win.webContents.send('library:sync-log', line)
      }
    }

    try {
      const result = await sync.syncAll(token, state.accountId, sendProgress, sendLog)
      if (result.vault.error || result.fab.error) {
        const combined = [result.vault.error, result.fab.error].filter(Boolean).join('; ')
        return { ok: false, error: combined }
      }
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })
}
