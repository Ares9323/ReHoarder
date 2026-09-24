import { describe, it, expect, vi, beforeEach } from 'vitest'
import { FabSessionClient, type FabPartitionCookies } from './fab-session'
import { InMemoryCookieJar } from '../http/cookie-jar'
import type { EpicWebSession } from '../auth/epic-web-session'
import type { EnsureLoggedInOptions } from './fab-web-session'

let web: { ensureLoggedIn: ReturnType<typeof vi.fn> }
let cookies: FabPartitionCookies & {
  fabCookieHeader: ReturnType<typeof vi.fn>
  importEpicCookies: ReturnType<typeof vi.fn>
}
let client: FabSessionClient
let epicSession: EpicWebSession

beforeEach(() => {
  web = { ensureLoggedIn: vi.fn().mockResolvedValue('logged-in') }
  cookies = {
    fabCookieHeader: vi.fn().mockResolvedValue('fab_sessionid=abc; fab_csrftoken=xyz'),
    importEpicCookies: vi.fn().mockResolvedValue(3)
  }
  client = new FabSessionClient(web, cookies)
  const jar = new InMemoryCookieJar()
  epicSession = {
    jar,
    ue4SessionReady: true,
    getCookieHeader: (host: string) => jar.getCookieHeader(new URL(`https://${host}/`))
  }
})

describe('FabSessionClient', () => {
  it('ensures a non-interactive login and returns the partition cookie header', async () => {
    const session = await client.establishSession('access-token', epicSession)
    expect(session.cookieHeader).toBe('fab_sessionid=abc; fab_csrftoken=xyz')
    expect(web.ensureLoggedIn).toHaveBeenCalledTimes(1)
    expect(web.ensureLoggedIn.mock.calls[0][0]).toMatchObject({ interactive: false })
  })

  it('seeds the Epic web cookies into the partition before a login attempt', async () => {
    web.ensureLoggedIn.mockImplementation(async (opts: EnsureLoggedInOptions) => {
      await opts.prepare?.()
      return 'logged-in'
    })
    await client.establishSession('access-token', epicSession)
    expect(cookies.importEpicCookies).toHaveBeenCalledWith(epicSession.jar)
  })

  it('still returns the cookie header when the web session is logged out', async () => {
    web.ensureLoggedIn.mockResolvedValue('logged-out')
    const log: string[] = []
    const session = await client.establishSession('t', epicSession, (l) => log.push(l))
    expect(session.cookieHeader).toBe('fab_sessionid=abc; fab_csrftoken=xyz')
    expect(log.some((l) => l.includes('logged-out'))).toBe(true)
  })
})
