import { app, BrowserWindow, safeStorage } from 'electron'
import { electronApp, optimizer } from '@electron-toolkit/utils'
import { createMainWindow } from './window'
import { openAppDb, type AppDb } from './db'
import { AssetsRepo } from './db/assets-repo'
import { SecureTokenStorage, type CryptoBackend } from './auth/secure-storage'
import { OAuthClient } from './auth/oauth-client'
import { Session, type AuthState } from './auth/session'
import { registerAuthIpc } from './auth/ipc'
import { VaultClient } from './vault/vault-client'
import { EpicWebSessionFactory } from './auth/epic-web-session'
import { ElectronCloudflareWarmer } from './cloudflare/cf-warmup'
import { createElectronFetch } from './http/electron-fetch'
import { FabSessionClient, FetchFabLoginDriver, type FabSessionLoader } from './fab/fab-session'
import { FabClient } from './fab/fab-client'
import { Sync } from './sync/sync'
import { registerLibraryIpc } from './sync/ipc'
import { registerDebugIpc } from './download/debug-ipc'
import { registerVaultIpc } from './vault-ipc'
import { SettingsStore } from './settings'
import { registerSettingsIpc } from './settings-ipc'
import { registerEnginesIpc } from './engines-ipc'
import { registerProjectsIpc } from './projects-ipc'
import { DownloadsRepo } from './db/downloads-repo'
import { DownloadsManager } from './downloads-manager'
import {
  broadcastDownloadProgress,
  broadcastDownloads,
  registerDownloadsIpc
} from './downloads-ipc'

let db: AppDb | null = null
let mainWindow: BrowserWindow | null = null

function makeElectronCrypto(): CryptoBackend {
  return {
    isEncryptionAvailable: () => safeStorage.isEncryptionAvailable(),
    encryptString: (s) => safeStorage.encryptString(s),
    decryptString: (b) => safeStorage.decryptString(b)
  }
}

function broadcastAuthState(state: AuthState): void {
  if (!mainWindow || mainWindow.isDestroyed()) return
  mainWindow.webContents.send('auth:state-changed', state)
}

app.whenReady().then(async () => {
  electronApp.setAppUserModelId('studio.rehoarder.app')

  db = openAppDb()
  console.warn(`[db] opened at ${app.getPath('userData')}/rehoarder.db`)

  const storage = new SecureTokenStorage(db.kv, makeElectronCrypto())
  const oauthClient = new OAuthClient()
  const session = new Session(storage, oauthClient)
  registerAuthIpc(session, broadcastAuthState)

  const assetsRepo = new AssetsRepo(db.raw)
  const vaultClient = new VaultClient()
  const CF_PARTITION = 'persist:cf-warmup'
  const cfWarmer = new ElectronCloudflareWarmer(CF_PARTITION)
  const epicWebSessionFactory = new EpicWebSessionFactory(undefined, undefined, cfWarmer)
  // Fab API calls go through net.fetch on the CF-warmup partition so the
  // Chromium TLS fingerprint and the cf_clearance cookie persisted there
  // are reused — Cloudflare validates both before letting traffic through.
  //
  // useSessionCookies: true so the handshake (F1-F5) behaves like a real
  // browser navigation — Chromium reads/writes the partition cookie store
  // along the redirect chain, including the intermediate Set-Cookie
  // headers `net.request` would otherwise swallow. The driver pre-seeds
  // the partition from our in-memory jar (which carries the freshly-
  // bootstrapped Epic web session cookies).
  const fabFetch = await createElectronFetch(CF_PARTITION, { useSessionCookies: true })
  const fabSessionLoader: FabSessionLoader = async () => {
    const { session } = await import('electron')
    return session.fromPartition(CF_PARTITION)
  }
  const fabLoginDriver = new FetchFabLoginDriver(fabFetch, fabSessionLoader)
  const fabSessionClient = new FabSessionClient(fabLoginDriver)
  const fabClient = new FabClient(fabFetch)
  const sync = new Sync(assetsRepo, vaultClient, epicWebSessionFactory, fabSessionClient, fabClient)
  registerLibraryIpc(assetsRepo, sync, session, () => mainWindow)
  registerDebugIpc({
    assetsRepo,
    session,
    epicWebSessionFactory,
    fabSessionClient,
    fabFetch,
    debugDir: app.getPath('userData')
  })
  const settingsStore = new SettingsStore(db.kv)
  registerSettingsIpc(settingsStore)
  registerVaultIpc(settingsStore)
  registerEnginesIpc(settingsStore)
  registerProjectsIpc(settingsStore)

  const downloadsRepo = new DownloadsRepo(db.raw)
  const downloadsManager = new DownloadsManager({
    repo: downloadsRepo,
    settings: settingsStore,
    runner: {
      assetsRepo,
      session,
      epicWebSessionFactory,
      fabSessionClient,
      fabFetch
    },
    broadcast: broadcastDownloads,
    broadcastProgress: broadcastDownloadProgress
  })
  registerDownloadsIpc(downloadsManager, settingsStore)
  downloadsManager.bootstrap()

  await session.init()
  console.warn(`[auth] initial state: ${session.getState().status}`)

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  mainWindow = createMainWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createMainWindow()
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('will-quit', () => {
  if (db) {
    db.raw.close()
    db = null
  }
})
