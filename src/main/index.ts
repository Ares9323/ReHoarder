import { app, BrowserWindow, protocol, safeStorage } from 'electron'
import * as path from 'node:path'
import { promises as fsp } from 'node:fs'
import { electronApp, optimizer } from '@electron-toolkit/utils'
import { VelopackApp } from 'velopack'
import { registerUpdatesIpc } from './updates-ipc'

// Velopack hook — MUST run before any other startup work. The installer
// re-invokes us with custom CLI args (first-run, update, uninstall, restart)
// and `VelopackApp.run()` will handle them and `process.exit` early when
// appropriate. Skipped in dev (no packaged install context).
if (app.isPackaged) {
  VelopackApp.build().run()
}
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

/**
 * Register a custom `rh-file://` protocol so the renderer can show local image
 * files (project auto-screenshots, engine thumbnails, etc.) without falling
 * foul of the renderer CSP. Every served path is checked against the
 * `projectPaths`, `enginePaths` and `vaultPaths` configured in Settings —
 * anything outside is refused.
 *
 * URL shape: `rh-file:///<absolute/path/to/file.png>`. Windows paths use
 * forward slashes in the URL but the validator resolves them back to native
 * separators before doing prefix checks.
 */
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'rh-file',
    privileges: { standard: true, supportFetchAPI: true, stream: true }
  }
])

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

// In dev the binary is `electron.exe`; the `brand-dev-electron` predev step
// rewrites its Win32 version-info so Task Manager shows "ReHoarder". This
// call sets the framework-level name (used by notifications, default dialog
// titles, the userData directory name on first run, etc.) — complementary
// to the exe-level rebrand.
app.setName('ReHoarder')

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

  // Register the `rh-file://` handler now that we have `settingsStore` to
  // consult for the allow-list of roots. Restricted to projectPaths /
  // enginePaths / vaultPaths so a malicious renderer can't read arbitrary
  // files off disk via the custom scheme.
  //
  // We read the file directly with `fsp.readFile` and build a `Response` —
  // `net.fetch('file://...')` is unreliable across Electron versions for the
  // custom-protocol-callback path.
  const MIME_BY_EXT: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
    '.bmp': 'image/bmp'
  }
  protocol.handle('rh-file', async (request) => {
    let resolvedPath: string
    try {
      const url = new URL(request.url)
      // Pathname looks like "/D:/projects/Foo/Saved/AutoScreenshot.png" on
      // Windows. Strip the leading slash only when it's followed by a drive
      // letter, so absolute POSIX paths like `/home/user/...` survive.
      let raw = decodeURIComponent(url.pathname)
      if (/^\/[A-Za-z]:/.test(raw)) raw = raw.slice(1)
      resolvedPath = path.resolve(raw)
    } catch (err) {
      console.warn('[rh-file] bad URL:', request.url, err)
      return new Response('Bad request', { status: 400 })
    }
    const cfg = settingsStore.load()
    const allowedRoots = [...cfg.projectPaths, ...cfg.enginePaths, ...cfg.vaultPaths]
    // On Windows path comparison is case-insensitive — `O:\UnrealArchive` and
    // `o:\unrealarchive` reach the same file, and `path.resolve` doesn't fold
    // the case. Without this the second/third entry in `projectPaths` whose
    // case differs from what the renderer sent would fail the prefix check
    // (= forbidden, image broken). Linux/macOS stay case-sensitive.
    const caseFold = process.platform === 'win32'
    const norm = (p: string): string => (caseFold ? p.toLowerCase() : p)
    const resolvedNorm = norm(resolvedPath)
    const allowed = allowedRoots.some((root) => {
      const r = norm(path.resolve(root))
      return resolvedNorm === r || resolvedNorm.startsWith(r + path.sep)
    })
    if (!allowed) {
      console.warn('[rh-file] forbidden:', resolvedPath, '| roots:', allowedRoots)
      return new Response('Forbidden', { status: 403 })
    }
    try {
      const data = await fsp.readFile(resolvedPath)
      const mime = MIME_BY_EXT[path.extname(resolvedPath).toLowerCase()] ?? 'application/octet-stream'
      // Wrap in a Blob — `protocol.handle`'s `Response` body is consumed by
      // Chromium's network stack, which reliably handles `Blob` but has had
      // bugs reading binary data from a bare `Uint8Array` wrapping a Node
      // `Buffer`. The Blob ctor copies the bytes into a managed store and
      // exposes the right MIME on the response side.
      return new Response(new Blob([new Uint8Array(data)], { type: mime }), {
        status: 200,
        headers: { 'Cache-Control': 'no-cache' }
      })
    } catch (err) {
      console.warn('[rh-file] not found:', resolvedPath, err)
      return new Response('Not found', { status: 404 })
    }
  })
  registerEnginesIpc(settingsStore)
  registerUpdatesIpc(() => mainWindow)
  const downloadsRepo = new DownloadsRepo(db.raw)
  registerVaultIpc(settingsStore, downloadsRepo, assetsRepo)
  registerProjectsIpc(settingsStore, downloadsRepo, assetsRepo)
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
  registerSettingsIpc(settingsStore, {
    onChange: () => downloadsManager.onSettingsChanged()
  })
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
