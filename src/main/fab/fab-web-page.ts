import { BrowserWindow, session as electronSession } from 'electron'
import type { CookieJar } from '../http/cookie-jar'
import { syncJarIntoSession } from '../http/electron-fetch'
import type { FabPage, FabPageFactory } from './fab-web-session'
import type { FabPartitionCookies } from './fab-session'

/**
 * Electron implementation of {@link FabPageFactory}: hidden or visible
 * BrowserWindows on the shared Fab partition, with the same UA the CF warmup
 * earned `cf_clearance` with (Cloudflare binds the clearance to the UA).
 */
export function createElectronFabPageFactory(opts: {
  partition: string
  userAgent: string
  getParent: () => BrowserWindow | null
}): FabPageFactory {
  return ({ visible }) => {
    electronSession.fromPartition(opts.partition).setUserAgent(opts.userAgent)
    const parent = visible ? opts.getParent() : null
    const usableParent = parent && !parent.isDestroyed() ? parent : undefined
    const win = new BrowserWindow({
      show: false,
      width: 1000,
      height: 800,
      title: 'Sign in to Fab',
      parent: usableParent,
      modal: usableParent !== undefined,
      autoHideMenuBar: true,
      webPreferences: {
        partition: opts.partition,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        devTools: false
      }
    })
    win.webContents.setUserAgent(opts.userAgent)
    // Popups (e.g. third-party sign-in providers) only make sense when the
    // user is looking at the window; hidden pages never open any.
    win.webContents.setWindowOpenHandler(() => ({ action: visible ? 'allow' : 'deny' }))
    if (visible) {
      win.on('page-title-updated', (e) => e.preventDefault())
      win.show()
    }

    let rewriter: ((url: string) => string | null) | null = null
    const onNav = (e: Electron.Event, url: string): void => {
      const target = rewriter?.(url)
      if (!target) return
      e.preventDefault()
      void win.webContents.loadURL(target).catch(() => {})
    }
    win.webContents.on('will-redirect', (e, url) => onNav(e, url))
    win.webContents.on('will-navigate', (e, url) => onNav(e, url))

    const page: FabPage = {
      loadURL: (url) => win.webContents.loadURL(url),
      getURL: () => (win.isDestroyed() ? '' : win.webContents.getURL()),
      executeJavaScript: (code) => win.webContents.executeJavaScript(code, true),
      setNavigationRewriter: (fn) => {
        rewriter = fn
      },
      onClosed: (cb) => {
        win.on('closed', cb)
      },
      isDestroyed: () => win.isDestroyed(),
      destroy: () => {
        if (!win.isDestroyed()) win.destroy()
      }
    }
    return page
  }
}

/** Partition cookie access for {@link FabSessionClient}. */
export function createPartitionCookies(partition: string): FabPartitionCookies {
  const sess = (): Electron.Session => electronSession.fromPartition(partition)
  return {
    async fabCookieHeader() {
      const cookies = await sess().cookies.get({ url: 'https://www.fab.com/' })
      return cookies.map((c) => `${c.name}=${c.value}`).join('; ')
    },
    async importEpicCookies(jar: CookieJar) {
      // Only the Epic side: the fab.com cookies in the partition belong to
      // the browser session and must not be overwritten with jar copies
      // (duplicate names such as `cf_clearance` confuse Fab).
      return syncJarIntoSession(jar, sess(), (suffix) => !suffix.endsWith('fab.com'))
    }
  }
}
