/**
 * Authenticated fab.com web session living in the `persist:cf-warmup`
 * partition.
 *
 * Fab's internal `/i/*` API only accepts requests coming from a real fab.com
 * page: a `net.fetch` with the partition cookies copied into a header still
 * answers 401 (see docs/superpowers/specs/2026-09-24-fab-web-session-design.md).
 * So every `/i/*` call runs as a same-origin `fetch` inside a hidden
 * www.fab.com page, and logging in happens in a real browser window:
 *
 *  - silent: hidden window on the Fab login entry, with the Epic authorize
 *    URL rewritten to drop `prompt=select_account` so Epic can auto-approve
 *    using the Epic web session already in the partition;
 *  - interactive: visible "Sign in to Fab" window, the user completes the
 *    Epic step by hand.
 *
 * Electron specifics live behind {@link FabPageFactory} (real implementation
 * in `fab-web-page.ts`) so this module stays unit-testable in Node.
 */

export type FabWebStatus = 'logged-in' | 'logged-out' | 'unknown'

/** The slice of a BrowserWindow this module needs. */
export interface FabPage {
  /** Starts a navigation. May reject (aborted or failed loads); callers poll `getURL`. */
  loadURL(url: string): Promise<void>
  getURL(): string
  executeJavaScript(code: string): Promise<unknown>
  /**
   * Hook on server redirects and page navigations: a non-null return value
   * cancels the navigation and loads the returned URL instead.
   */
  setNavigationRewriter(fn: (url: string) => string | null): void
  /** Fired when the user closes the window. */
  onClosed(cb: () => void): void
  isDestroyed(): boolean
  destroy(): void
}

export type FabPageFactory = (opts: { visible: boolean }) => FabPage

export interface FabWebSessionOptions {
  createPage: FabPageFactory
  /** Host page is destroyed after this long without `/i/` calls. */
  idleMs?: number
  silentTimeoutMs?: number
  interactiveTimeoutMs?: number
  /** How long the silent window may sit on the Epic login form before giving up. */
  loginFormGraceMs?: number
  /** After a failed silent login, further non-interactive attempts are skipped this long. */
  silentCooldownMs?: number
  pollMs?: number
  loadTimeoutMs?: number
}

export interface EnsureLoggedInOptions {
  /** `false` tries only the silent login; `true` falls back to a visible window. */
  interactive: boolean
  onLog?: (line: string) => void
  /** Runs once right before a login attempt (e.g. seed Epic cookies into the partition). */
  prepare?: () => Promise<void>
}

export const FAB_HOME_URL = 'https://www.fab.com/'
export const FAB_LOGIN_URL = 'https://www.fab.com/social/login/epic/?next=/library'
const STATUS_PROBE_PATH = '/i/users/me/wallet'

/** 200 → logged-in, 401/403 → logged-out, anything else (incl. -1) → unknown. */
export function statusFromHttp(status: number): FabWebStatus {
  if (status >= 200 && status < 300) return 'logged-in'
  if (status === 401 || status === 403) return 'logged-out'
  return 'unknown'
}

/** Only same-origin Fab internal API paths may be fetched from the page. */
export function isFabApiPath(path: string): boolean {
  return /^\/i\/[^\s]*$/.test(path)
}

/**
 * `/i/library/search` paginates with an absolute `next` URL. Converts it to
 * a path + query for {@link FabWebSession.getJson}; null when absent or when
 * it points outside www.fab.com.
 */
export function fabNextToPath(next: string | null | undefined): string | null {
  if (!next) return null
  let u: URL
  try {
    u = new URL(next, FAB_HOME_URL)
  } catch {
    return null
  }
  if (u.origin !== 'https://www.fab.com') return null
  const path = u.pathname + u.search
  return isFabApiPath(path) ? path : null
}

/**
 * Epic authorize URL with `prompt=select_account` removed, or null when the
 * URL is not an Epic authorize URL carrying that prompt.
 */
export function rewriteEpicAuthorizeUrl(url: string): string | null {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return null
  }
  if (u.hostname !== 'www.epicgames.com' && u.hostname !== 'epicgames.com') return null
  if (!/^\/id(\/api)?\/authorize/.test(u.pathname)) return null
  if (u.searchParams.get('prompt') !== 'select_account') return null
  u.searchParams.delete('prompt')
  return u.toString()
}

/** A www.fab.com page outside the `/social/` login routes. */
function isFabLanding(url: string): boolean {
  return url.startsWith(FAB_HOME_URL) && !url.startsWith(`${FAB_HOME_URL}social/`)
}

/** The Epic login form (not the account chooser): silent login cannot pass it. */
function isEpicLoginForm(url: string): boolean {
  try {
    const u = new URL(url)
    return u.hostname.endsWith('epicgames.com') && u.pathname.startsWith('/id/login')
  } catch {
    return false
  }
}

function inPageFetchScript(path: string): string {
  return `(async () => {
  try {
    const m = document.cookie.match(/(?:^|; )fab_csrftoken=([^;]+)/);
    const r = await fetch(${JSON.stringify(path)}, {
      credentials: 'include',
      cache: 'no-store',
      headers: { 'X-Requested-With': 'XMLHttpRequest', 'X-CsrfToken': m ? m[1] : '', Accept: 'application/json' }
    });
    return { status: r.status, text: await r.text() };
  } catch (e) {
    return { status: -1, text: String(e && e.message ? e.message : e) };
  }
})()`
}

type LoginOutcome = 'landed' | 'closed' | 'timeout' | 'login-form'

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export class FabWebSession {
  private readonly createPage: FabPageFactory
  private readonly idleMs: number
  private readonly silentTimeoutMs: number
  private readonly interactiveTimeoutMs: number
  private readonly loginFormGraceMs: number
  private readonly silentCooldownMs: number
  private readonly pollMs: number
  private readonly loadTimeoutMs: number

  private host: FabPage | null = null
  private idleTimer: ReturnType<typeof setTimeout> | null = null
  private loginPage: FabPage | null = null
  private inFlight: { interactive: boolean; promise: Promise<FabWebStatus> } | null = null
  private lastSilentFailAt: number | null = null

  constructor(opts: FabWebSessionOptions) {
    this.createPage = opts.createPage
    this.idleMs = opts.idleMs ?? 5 * 60_000
    this.silentTimeoutMs = opts.silentTimeoutMs ?? 30_000
    this.interactiveTimeoutMs = opts.interactiveTimeoutMs ?? 5 * 60_000
    this.loginFormGraceMs = opts.loginFormGraceMs ?? 4_000
    this.silentCooldownMs = opts.silentCooldownMs ?? 10 * 60_000
    this.pollMs = opts.pollMs ?? 500
    this.loadTimeoutMs = opts.loadTimeoutMs ?? 30_000
  }

  /** In-page GET of `/i/users/me/wallet`: 200 → logged-in, 401/403 → logged-out. */
  async checkStatus(): Promise<FabWebStatus> {
    const { status } = await this.inPageFetch(STATUS_PROBE_PATH)
    return statusFromHttp(status)
  }

  /** In-page same-origin fetch of a `/i/...` path; status + parsed JSON (null when not JSON). */
  async getJson<T>(path: string): Promise<{ status: number; body: T | null }> {
    if (!isFabApiPath(path)) {
      throw new Error(`FabWebSession.getJson only accepts /i/ paths (got ${path})`)
    }
    const { status, text } = await this.inPageFetch(path)
    let body: T | null = null
    if (status >= 200 && status < 300) {
      try {
        body = JSON.parse(text) as T
      } catch {
        body = null
      }
    }
    return { status, body }
  }

  /**
   * Make sure the session is authenticated. Never throws for "user closed
   * the window"; resolves to the final status. One attempt at a time:
   * concurrent callers share the in-flight promise.
   */
  async ensureLoggedIn(opts: EnsureLoggedInOptions): Promise<FabWebStatus> {
    const current = this.inFlight
    if (current) {
      if (current.interactive || !opts.interactive) return current.promise
      const r = await current.promise
      if (r === 'logged-in') return r
      return this.ensureLoggedIn(opts)
    }
    const entry = {
      interactive: opts.interactive,
      promise: this.runEnsure(opts).finally(() => {
        if (this.inFlight === entry) this.inFlight = null
      })
    }
    this.inFlight = entry
    return entry.promise
  }

  dispose(): void {
    this.clearIdleTimer()
    if (this.host && !this.host.isDestroyed()) this.host.destroy()
    this.host = null
    if (this.loginPage && !this.loginPage.isDestroyed()) this.loginPage.destroy()
    this.loginPage = null
  }

  private async runEnsure(opts: EnsureLoggedInOptions): Promise<FabWebStatus> {
    const log = opts.onLog ?? ((): void => {})
    const initial = await this.checkStatus()
    if (initial === 'logged-in') {
      log('Fab: web session already signed in')
      return initial
    }

    const inCooldown =
      this.lastSilentFailAt !== null && Date.now() - this.lastSilentFailAt < this.silentCooldownMs
    if (inCooldown && !opts.interactive) {
      log(`Fab: web session ${initial}, silent login skipped (it failed recently)`)
      return 'logged-out'
    }

    if (opts.prepare) {
      try {
        await opts.prepare()
      } catch (err) {
        log(`Fab: login preparation failed (${err instanceof Error ? err.message : String(err)})`)
      }
    }

    if (!inCooldown) {
      log(`Fab: web session ${initial}, trying silent login`)
      const outcome = await this.runLoginWindow(false)
      if (outcome === 'landed') {
        const s = await this.checkStatus()
        if (s === 'logged-in') {
          this.lastSilentFailAt = null
          log('Fab: signed in to fab.com (silent login)')
          return s
        }
        log(`Fab: silent login landed on fab.com but the session is ${s}`)
      } else {
        log(`Fab: silent login failed (${outcome})`)
      }
      this.lastSilentFailAt = Date.now()
    }

    if (!opts.interactive) return 'logged-out'

    log('Fab: opening the "Sign in to Fab" window')
    const outcome = await this.runLoginWindow(true)
    if (outcome === 'landed') {
      const s = await this.checkStatus()
      log(
        s === 'logged-in'
          ? 'Fab: signed in to fab.com (interactive login)'
          : `Fab: interactive login landed on fab.com but the session is ${s}`
      )
      if (s === 'logged-in') this.lastSilentFailAt = null
      return s === 'logged-in' ? s : 'logged-out'
    }
    log(`Fab: interactive login ended without sign-in (${outcome})`)
    return 'logged-out'
  }

  /** Drive one login window until it lands on fab.com, closes, times out or hits a login form. */
  private async runLoginWindow(visible: boolean): Promise<LoginOutcome> {
    const page = this.createPage({ visible })
    this.loginPage = page
    let closed = false
    page.onClosed(() => {
      closed = true
    })
    if (!visible) page.setNavigationRewriter(rewriteEpicAuthorizeUrl)
    void page.loadURL(FAB_LOGIN_URL).catch(() => {})

    const deadline = Date.now() + (visible ? this.interactiveTimeoutMs : this.silentTimeoutMs)
    let loginFormSince: number | null = null
    let lastRewrite: string | null = null
    try {
      while (true) {
        if (closed || page.isDestroyed()) return 'closed'
        const url = page.getURL()
        if (isFabLanding(url)) return 'landed'
        if (!visible) {
          // Fallback for client-side navigations the rewriter hook missed:
          // the page settled on the account chooser, load the rewritten URL.
          const rewritten = rewriteEpicAuthorizeUrl(url)
          if (rewritten && rewritten !== lastRewrite) {
            lastRewrite = rewritten
            void page.loadURL(rewritten).catch(() => {})
          }
          if (isEpicLoginForm(url)) {
            loginFormSince ??= Date.now()
            if (Date.now() - loginFormSince >= this.loginFormGraceMs) return 'login-form'
          } else {
            loginFormSince = null
          }
        }
        if (Date.now() >= deadline) return 'timeout'
        await sleep(this.pollMs)
      }
    } finally {
      if (!page.isDestroyed()) page.destroy()
      if (this.loginPage === page) this.loginPage = null
    }
  }

  private async inPageFetch(path: string): Promise<{ status: number; text: string }> {
    this.touch()
    const script = inPageFetchScript(path)
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const page = await this.hostPage(attempt > 0)
        const res = (await page.executeJavaScript(script)) as { status?: unknown; text?: unknown }
        if (res && typeof res.status === 'number' && res.status !== -1) {
          return { status: res.status, text: typeof res.text === 'string' ? res.text : '' }
        }
      } catch {
        /* page crashed or navigated away: reload and retry once */
      }
    }
    return { status: -1, text: '' }
  }

  private async hostPage(forceReload: boolean): Promise<FabPage> {
    if (!this.host || this.host.isDestroyed()) {
      this.host = this.createPage({ visible: false })
      forceReload = true
    }
    const host = this.host
    if (forceReload || !isFabLanding(host.getURL())) {
      let timer: ReturnType<typeof setTimeout> | undefined
      await Promise.race([
        host.loadURL(FAB_HOME_URL).catch(() => {}),
        new Promise<void>((r) => {
          timer = setTimeout(r, this.loadTimeoutMs)
        })
      ])
      clearTimeout(timer)
    }
    return host
  }

  private touch(): void {
    this.clearIdleTimer()
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null
      if (this.host && !this.host.isDestroyed()) this.host.destroy()
      this.host = null
    }, this.idleMs)
    ;(this.idleTimer as { unref?: () => void }).unref?.()
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = null
  }
}
