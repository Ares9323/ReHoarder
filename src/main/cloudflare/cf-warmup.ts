/**
 * Cloudflare warmup — pre-establish cf_clearance + __cf_bm cookies before
 * the F1-F5 Fab handshake runs.
 *
 * Why: www.fab.com is behind Cloudflare. A bare Node `fetch` to
 * /social/login/epic/?next=/library returns HTTP 403 because Cloudflare
 * rejects clients without a valid `cf_clearance` cookie. Browsers obtain
 * this cookie by passing a JS challenge (or transparent fingerprint check).
 *
 * Since ReHoarder uses an external-browser `authorization_code` flow (no
 * in-app BrowserWindow at login time), we need an explicit warmup step
 * before the Fab handshake to acquire `cf_clearance` the way a real
 * browser would.
 *
 * Strategy: open a hidden Electron BrowserWindow on a dedicated persistent
 * partition, set its User-Agent to LAUNCHER_UA (same UA used by our Node
 * fetch later — important: cf_clearance is bound to UA), navigate to
 * https://www.fab.com/ to let Chromium pass the Cloudflare challenge,
 * then export the resulting cookies into the Node CookieJar.
 *
 * The partition is `persist:cf-warmup` — Electron persists cookies on disk
 * across app restarts, so subsequent syncs reuse a valid cf_clearance
 * without re-running the full warmup challenge.
 */

import type { CookieJar } from '../http/cookie-jar'
import { LAUNCHER_UA } from '../http/user-agents'

export interface CloudflareWarmer {
  warmupInto(jar: CookieJar, onLog?: (msg: string) => void): Promise<void>
}

export class NoopCloudflareWarmer implements CloudflareWarmer {
  async warmupInto(_jar: CookieJar, _onLog?: (msg: string) => void): Promise<void> {
    void _jar
    void _onLog
  }
}

interface ElectronCookieLike {
  name: string
  value: string
  domain?: string
  path?: string
}

/**
 * Inject Electron-style cookie objects into our InMemoryCookieJar by
 * converting each to a synthetic Set-Cookie header and replaying it
 * through the jar's own captureFromResponse path. Keeps the jar API
 * surface unchanged.
 */
export function injectCookies(jar: CookieJar, cookies: ElectronCookieLike[]): void {
  for (const c of cookies) {
    if (!c.name) continue
    const domain = c.domain ?? ''
    const path = c.path ?? '/'
    const host = domain.startsWith('.') ? domain.slice(1) : domain
    if (!host) continue
    const setCookie = domain
      ? `${c.name}=${c.value}; Domain=${domain}; Path=${path}`
      : `${c.name}=${c.value}; Path=${path}`
    const headers = new Headers()
    headers.append('Set-Cookie', setCookie)
    jar.captureFromResponse(new URL(`https://${host}/`), headers)
  }
}

const FAB_WARMUP_URL = 'https://www.fab.com/'
const EPIC_WARMUP_URL = 'https://www.epicgames.com/id/login'
/** unrealengine.com owns `cf_clearance` for the Epic-Houdini `set-sid`
 *  endpoint (`/id/api/set-sid`). Without warming this domain, Node fetch
 *  hits a Cloudflare challenge page and 403s — which cascades into a
 *  half-built Epic web session, anonymous Fab session, and 401 on every
 *  Fab `/me/...` endpoint. The warmup happens once per partition lifetime;
 *  the resulting cookie is persisted across launches. */
const UE_WARMUP_URL = 'https://www.unrealengine.com/'

/**
 * Real Electron-backed warmer. Constructed lazily inside `warmupInto` so
 * that `import`ing this module from non-Electron contexts (tests) does
 * not crash. The `electron` module is required at call time.
 */
export class ElectronCloudflareWarmer implements CloudflareWarmer {
  constructor(
    private readonly partition: string = 'persist:cf-warmup',
    private readonly userAgent: string = LAUNCHER_UA,
    private readonly settleMs: number = 2000,
    private readonly loadTimeoutMs: number = 15000
  ) {}

  async warmupInto(jar: CookieJar, onLog: (msg: string) => void = () => {}): Promise<void> {
    const electron = await import('electron')
    const { BrowserWindow, session: electronSession } = electron

    const sess = electronSession.fromPartition(this.partition)
    sess.setUserAgent(this.userAgent)

    const win = new BrowserWindow({
      show: false,
      width: 800,
      height: 900,
      webPreferences: {
        partition: this.partition,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        devTools: false
      }
    })
    win.webContents.setUserAgent(this.userAgent)

    try {
      await this.navigateWithTimeout(win, FAB_WARMUP_URL, onLog)
      await delay(this.settleMs)

      // Epic /id/login is the route a browser implicitly traverses during
      // login and is the host that owns `cf_clearance` for the Epic side
      // of the dance. Warm it too so Fab redirects through epicgames.com
      // see a valid cookie.
      await this.navigateWithTimeout(win, EPIC_WARMUP_URL, onLog)
      await delay(this.settleMs)

      // unrealengine.com owns its own CF zone; the Epic-Houdini `set-sid`
      // call (cross-origin from epicgames.com → unrealengine.com) needs
      // `cf_clearance` here or it 403s with the CF challenge HTML.
      await this.navigateWithTimeout(win, UE_WARMUP_URL, onLog)
      await delay(this.settleMs)

      const fabCookies = await sess.cookies.get({ domain: 'fab.com' })
      const epicCookies = await sess.cookies.get({ domain: 'epicgames.com' })
      const ueCookies = await sess.cookies.get({ domain: 'unrealengine.com' })

      // For epicgames.com keep ONLY Cloudflare-managed cookies. Other
      // Epic state cookies (XSRF-TOKEN, EPIC_DEVICE, _tald, …) from the
      // warmup partition conflict with the fresh CSRF/session that our
      // E1-E3 Node-fetch chain establishes — leading to /id/api/exchange
      // returning HTTP 409.
      //
      // For fab.com keep EVERYTHING (cf_clearance, __cf_bm, AND the
      // anonymous fab_csrftoken Fab sets on first visit). Fab's OAuth
      // callback at F5 validates the request's csrftoken cookie against
      // the `state` query param; dropping fab_csrftoken makes Fab reply
      // 302 → /?error_code=1 with no fab_sessionid set.
      const isCfCookie = (c: ElectronCookieLike) =>
        c.name === 'cf_clearance' || c.name === '__cf_bm'
      // Fab assigns an anonymous `fab_sessionid` on every first visit. If we
      // forward it into the in-memory jar, `syncJarIntoSession` puts it back
      // into the partition right after we purge the stale one — and Fab's F5
      // OAuth callback then declines to issue a fresh authenticated session
      // because it already finds a valid (anonymous) one in the request.
      // Result: /me/listings-states 401 across launches. Drop it here.
      const isAnonymousFabSession = (c: ElectronCookieLike) =>
        c.name === 'fab_sessionid' || c.name === 'sessionid'
      const keptFab = fabCookies.filter((c) => !isAnonymousFabSession(c))
      const keptEpic = epicCookies.filter(isCfCookie)
      // For unrealengine.com we only need the CF cookies — the rest of
      // the UE state is established later by `set-sid`.
      const keptUe = ueCookies.filter(isCfCookie)
      const total = keptFab.length + keptEpic.length + keptUe.length
      const hasFabClearance = keptFab.some((c) => c.name === 'cf_clearance')
      const hasEpicClearance = keptEpic.some((c) => c.name === 'cf_clearance')
      const hasUeClearance = keptUe.some((c) => c.name === 'cf_clearance')
      const hasFabCsrf = keptFab.some((c) => c.name === 'fab_csrftoken')
      onLog(
        `CF warmup: ${total} cookies retained ` +
          `(cf_clearance fab=${hasFabClearance ? 'yes' : 'no'}, ` +
          `epic=${hasEpicClearance ? 'yes' : 'no'}, ` +
          `ue=${hasUeClearance ? 'yes' : 'no'}, ` +
          `fab_csrftoken=${hasFabCsrf ? 'yes' : 'no'})`
      )

      injectCookies(jar, [...keptFab, ...keptEpic, ...keptUe])
    } finally {
      if (!win.isDestroyed()) win.destroy()
    }
  }

  private async navigateWithTimeout(
    win: Electron.BrowserWindow,
    url: string,
    onLog: (msg: string) => void
  ): Promise<void> {
    onLog(`CF warmup: navigating to ${url}`)
    try {
      await Promise.race([
        win.loadURL(url),
        new Promise<void>((_, reject) =>
          setTimeout(() => reject(new Error('load timeout')), this.loadTimeoutMs)
        )
      ])
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      onLog(`CF warmup: navigation to ${url} failed (${msg}) — continuing`)
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
