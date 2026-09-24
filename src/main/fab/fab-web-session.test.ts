import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  FabWebSession,
  fabNextToPath,
  isFabApiPath,
  rewriteEpicAuthorizeUrl,
  statusFromHttp,
  type FabPage,
  type FabPageFactory
} from './fab-web-session'

/**
 * Scriptable stand-in for a BrowserWindow. `route` decides what URL a
 * `loadURL` lands on; `exec` answers the in-page fetch script.
 */
class FakePage implements FabPage {
  url = ''
  destroyed = false
  rewriter: ((url: string) => string | null) | null = null
  closedCb: (() => void) | null = null
  loads: string[] = []
  constructor(
    readonly visible: boolean,
    private readonly route: (url: string, page: FakePage) => string,
    private readonly exec: (code: string) => Promise<unknown>
  ) {}
  async loadURL(url: string): Promise<void> {
    this.loads.push(url)
    let target = this.route(url, this)
    const rewritten = this.rewriter?.(target)
    if (rewritten) {
      this.loads.push(rewritten)
      target = this.route(rewritten, this)
    }
    this.url = target
  }
  getURL(): string {
    return this.url
  }
  executeJavaScript(code: string): Promise<unknown> {
    return this.exec(code)
  }
  setNavigationRewriter(fn: (url: string) => string | null): void {
    this.rewriter = fn
  }
  onClosed(cb: () => void): void {
    this.closedCb = cb
  }
  isDestroyed(): boolean {
    return this.destroyed
  }
  destroy(): void {
    this.destroyed = true
  }
  close(): void {
    this.destroyed = true
    this.closedCb?.()
  }
}

const AUTHORIZE =
  'https://www.epicgames.com/id/authorize?client_id=abc&response_type=code&prompt=select_account&redirect_uri=x'
const LANDED = 'https://www.fab.com/library'

function pathOf(code: string): string {
  const m = code.match(/fetch\(("[^"]*")/)
  return m ? (JSON.parse(m[1]) as string) : ''
}

describe('pure helpers', () => {
  it('maps HTTP statuses to a web status', () => {
    expect(statusFromHttp(200)).toBe('logged-in')
    expect(statusFromHttp(401)).toBe('logged-out')
    expect(statusFromHttp(403)).toBe('logged-out')
    expect(statusFromHttp(-1)).toBe('unknown')
    expect(statusFromHttp(500)).toBe('unknown')
  })

  it('only accepts same-origin /i/ paths', () => {
    expect(isFabApiPath('/i/library/search?source=acquired')).toBe(true)
    expect(isFabApiPath('/e/accounts/x')).toBe(false)
    expect(isFabApiPath('https://evil.example/i/x')).toBe(false)
    expect(isFabApiPath('//evil.example/i/x')).toBe(false)
    expect(isFabApiPath('/i/ x')).toBe(false)
  })

  it('converts an absolute next URL to path + query', () => {
    expect(fabNextToPath('https://www.fab.com/i/library/search?cursor=abc&source=acquired')).toBe(
      '/i/library/search?cursor=abc&source=acquired'
    )
    expect(fabNextToPath('/i/library/search?cursor=abc')).toBe('/i/library/search?cursor=abc')
    expect(fabNextToPath(null)).toBeNull()
    expect(fabNextToPath('https://evil.example/i/library/search')).toBeNull()
  })

  it('removes prompt=select_account from the Epic authorize URL only', () => {
    const out = rewriteEpicAuthorizeUrl(AUTHORIZE)
    expect(out).not.toBeNull()
    const u = new URL(out as string)
    expect(u.searchParams.has('prompt')).toBe(false)
    expect(u.searchParams.get('client_id')).toBe('abc')
    expect(rewriteEpicAuthorizeUrl(out as string)).toBeNull()
    expect(rewriteEpicAuthorizeUrl('https://www.fab.com/?prompt=select_account')).toBeNull()
    expect(rewriteEpicAuthorizeUrl('not a url')).toBeNull()
  })
})

describe('FabWebSession', () => {
  let pages: FakePage[]
  let signedIn: boolean
  /** Where the Epic authorize URL goes: with the prompt it stops on the chooser. */
  let authorizeLandsOn: (url: string) => string
  let execImpl: (code: string) => Promise<unknown>

  const route = (url: string): string => {
    if (url.startsWith('https://www.fab.com/social/login/epic/')) return AUTHORIZE
    if (url.startsWith('https://www.epicgames.com/id/authorize')) return authorizeLandsOn(url)
    return url
  }

  const factory: FabPageFactory = ({ visible }) => {
    const p = new FakePage(visible, route, (code) => execImpl(code))
    pages.push(p)
    return p
  }

  function makeSession(overrides: Partial<ConstructorParameters<typeof FabWebSession>[0]> = {}) {
    return new FabWebSession({
      createPage: factory,
      pollMs: 1,
      silentTimeoutMs: 50,
      interactiveTimeoutMs: 50,
      loginFormGraceMs: 5,
      ...overrides
    })
  }

  beforeEach(() => {
    pages = []
    signedIn = false
    authorizeLandsOn = (url) => {
      if (new URL(url).searchParams.get('prompt') === 'select_account') return url
      signedIn = true
      return LANDED
    }
    execImpl = async (code) => {
      const path = pathOf(code)
      if (path === '/i/users/me/wallet') return { status: signedIn ? 200 : 401, text: '{}' }
      return { status: 200, text: JSON.stringify({ path }) }
    }
  })

  it('getJson runs the fetch in a hidden fab.com page and parses JSON', async () => {
    const s = makeSession()
    const r = await s.getJson<{ path: string }>('/i/library/search?source=acquired')
    expect(r).toEqual({ status: 200, body: { path: '/i/library/search?source=acquired' } })
    expect(pages).toHaveLength(1)
    expect(pages[0].visible).toBe(false)
    expect(pages[0].loads).toEqual(['https://www.fab.com/'])
    s.dispose()
  })

  it('getJson reuses the host page while it stays on www.fab.com', async () => {
    const s = makeSession()
    await s.getJson('/i/a')
    await s.getJson('/i/b')
    expect(pages).toHaveLength(1)
    expect(pages[0].loads).toHaveLength(1)
    pages[0].url = 'https://challenges.cloudflare.com/x'
    await s.getJson('/i/c')
    expect(pages[0].loads).toEqual(['https://www.fab.com/', 'https://www.fab.com/'])
    s.dispose()
  })

  it('getJson rejects paths outside /i/', async () => {
    const s = makeSession()
    await expect(s.getJson('https://evil.example/x')).rejects.toThrow(/\/i\//)
    expect(pages).toHaveLength(0)
  })

  it('getJson returns a null body for non-JSON text', async () => {
    execImpl = async () => ({ status: 502, text: '<html>bad gateway</html>' })
    const s = makeSession()
    expect(await s.getJson('/i/x')).toEqual({ status: 502, body: null })
    s.dispose()
  })

  it('getJson reloads the host page once after a script failure, then gives -1', async () => {
    const exec = vi.fn().mockRejectedValue(new Error('page crashed'))
    execImpl = exec
    const s = makeSession()
    expect(await s.getJson('/i/x')).toEqual({ status: -1, body: null })
    expect(exec).toHaveBeenCalledTimes(2)
    expect(pages[0].loads).toHaveLength(2)
    s.dispose()
  })

  it('getJson recovers when the retry after reload succeeds', async () => {
    let n = 0
    execImpl = async () => (++n === 1 ? { status: -1, text: 'Failed to fetch' } : { status: 200, text: '[1]' })
    const s = makeSession()
    expect(await s.getJson('/i/x')).toEqual({ status: 200, body: [1] })
    s.dispose()
  })

  it('checkStatus maps the wallet probe', async () => {
    const s = makeSession()
    expect(await s.checkStatus()).toBe('logged-out')
    signedIn = true
    expect(await s.checkStatus()).toBe('logged-in')
    execImpl = async () => ({ status: -1, text: '' })
    expect(await s.checkStatus()).toBe('unknown')
    s.dispose()
  })

  it('ensureLoggedIn does nothing when already signed in', async () => {
    signedIn = true
    const prepare = vi.fn()
    const s = makeSession()
    expect(await s.ensureLoggedIn({ interactive: false, prepare })).toBe('logged-in')
    expect(prepare).not.toHaveBeenCalled()
    expect(pages).toHaveLength(1)
    s.dispose()
  })

  it('silent login rewrites the authorize URL and signs in without a visible window', async () => {
    const log: string[] = []
    const prepare = vi.fn().mockResolvedValue(undefined)
    const s = makeSession()
    const status = await s.ensureLoggedIn({ interactive: false, onLog: (l) => log.push(l), prepare })
    expect(status).toBe('logged-in')
    expect(prepare).toHaveBeenCalledTimes(1)
    expect(pages.some((p) => p.visible)).toBe(false)
    const loginPage = pages[1]
    expect(loginPage.loads[0]).toBe('https://www.fab.com/social/login/epic/?next=/library')
    expect(loginPage.loads.some((u) => u.includes('/id/authorize') && !u.includes('prompt='))).toBe(
      true
    )
    expect(loginPage.destroyed).toBe(true)
    expect(log.some((l) => l.includes('silent login'))).toBe(true)
    s.dispose()
  })

  it('silent login failing leaves the session logged out and shows no window', async () => {
    authorizeLandsOn = () => 'https://www.epicgames.com/id/login?redirectUrl=x'
    const s = makeSession()
    expect(await s.ensureLoggedIn({ interactive: false })).toBe('logged-out')
    expect(pages.some((p) => p.visible)).toBe(false)
    s.dispose()
  })

  it('skips the silent attempt during the cooldown after a failure', async () => {
    authorizeLandsOn = (url) => url // stuck on the chooser
    const s = makeSession()
    await s.ensureLoggedIn({ interactive: false })
    const loginPagesBefore = pages.length
    expect(await s.ensureLoggedIn({ interactive: false })).toBe('logged-out')
    expect(pages.length).toBe(loginPagesBefore)
    s.dispose()
  })

  it('interactive login falls back to a visible window without the prompt rewrite', async () => {
    authorizeLandsOn = () => 'https://www.epicgames.com/id/login'
    const log: string[] = []
    const s = makeSession({
      createPage: (opts) => {
        const p = factory(opts) as FakePage
        if (opts.visible) {
          // The user picks the account in the chooser: the page ends on Fab.
          setTimeout(() => {
            signedIn = true
            p.url = LANDED
          }, 5)
        }
        return p
      }
    })
    const status = await s.ensureLoggedIn({ interactive: true, onLog: (l) => log.push(l) })
    expect(status).toBe('logged-in')
    const visible = pages.find((p) => p.visible)
    expect(visible).toBeDefined()
    expect(visible?.rewriter).toBeNull()
    expect(log.some((l) => l.includes('interactive login'))).toBe(true)
    s.dispose()
  })

  it('interactive login resolves logged-out when the user closes the window', async () => {
    authorizeLandsOn = (url) => url
    const s = makeSession({
      interactiveTimeoutMs: 5000,
      createPage: (opts) => {
        const p = factory(opts) as FakePage
        if (opts.visible) setTimeout(() => p.close(), 5)
        return p
      }
    })
    expect(await s.ensureLoggedIn({ interactive: true })).toBe('logged-out')
    s.dispose()
  })

  it('serializes concurrent logins into one attempt', async () => {
    const s = makeSession()
    const [a, b] = await Promise.all([
      s.ensureLoggedIn({ interactive: false }),
      s.ensureLoggedIn({ interactive: false })
    ])
    expect(a).toBe('logged-in')
    expect(b).toBe('logged-in')
    const loginPages = pages.filter((p) => p.loads[0]?.includes('/social/login/'))
    expect(loginPages).toHaveLength(1)
    s.dispose()
  })

  it('destroys the host page after the idle timeout', async () => {
    vi.useFakeTimers()
    try {
      const s = makeSession({ idleMs: 1000 })
      await s.getJson('/i/x')
      expect(pages[0].destroyed).toBe(false)
      vi.advanceTimersByTime(1001)
      expect(pages[0].destroyed).toBe(true)
      s.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('dispose destroys the host page', async () => {
    const s = makeSession()
    await s.getJson('/i/x')
    s.dispose()
    expect(pages[0].destroyed).toBe(true)
  })
})
