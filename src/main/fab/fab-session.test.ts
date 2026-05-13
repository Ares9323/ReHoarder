import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  FabSessionClient,
  FabHandshakeError,
  FetchFabLoginDriver,
  type FabLoginDriver
} from './fab-session'
import { InMemoryCookieJar } from '../http/cookie-jar'
import type { EpicWebSession } from '../auth/epic-web-session'

let driver: FabLoginDriver & { login: ReturnType<typeof vi.fn> }
let client: FabSessionClient
let epicSession: EpicWebSession

beforeEach(() => {
  driver = { login: vi.fn() }
  client = new FabSessionClient(driver)
  const jar = new InMemoryCookieJar()
  jar.captureFromResponse(
    new URL('https://www.epicgames.com/'),
    new Headers({ 'Set-Cookie': 'EPIC_SESSION_AP=sess; Domain=.epicgames.com' })
  )
  epicSession = {
    jar,
    ue4SessionReady: true,
    getCookieHeader: (host: string) => jar.getCookieHeader(new URL(`https://${host}/`))
  }
})

describe('FabSessionClient', () => {
  it('delegates to the driver and returns its cookieHeader', async () => {
    driver.login.mockResolvedValueOnce(
      'fab_sessionid=abc; fab_csrftoken=xyz; cf_clearance=cf'
    )
    const session = await client.establishSession('access-token', epicSession)
    expect(session.cookieHeader).toBe('fab_sessionid=abc; fab_csrftoken=xyz; cf_clearance=cf')
    expect(driver.login).toHaveBeenCalledTimes(1)
    expect(driver.login).toHaveBeenCalledWith(epicSession, expect.any(Function))
  })

  it('propagates driver errors (e.g. Epic session invalid)', async () => {
    driver.login.mockRejectedValueOnce(
      new FabHandshakeError('epic-session-invalid', 'Fab login redirected to /id/login')
    )
    const error = await client.establishSession('access-token', epicSession).catch((e) => e)
    expect(error).toBeInstanceOf(FabHandshakeError)
    expect((error as FabHandshakeError).step).toBe('epic-session-invalid')
  })

  it('passes the same epicSession instance to the driver', async () => {
    driver.login.mockResolvedValueOnce('fab_sessionid=ok')
    await client.establishSession('access-token', epicSession)
    expect(driver.login.mock.calls[0][0]).toBe(epicSession)
  })
})

describe('FetchFabLoginDriver — F1-F5 sequence', () => {
  let fetchMock: ReturnType<typeof vi.fn>
  let driver: FetchFabLoginDriver
  let session: EpicWebSession
  let jar: InMemoryCookieJar

  const OAUTH_URL =
    'https://www.epicgames.com/id/api/authorize?client_id=abc123def456&redirect_uri=https%3A%2F%2Fwww.fab.com%2Fsocial%2Fcomplete%2Fepic%2F&response_type=code&scope=basic_profile&state=stateABC'
  const FAB_CALLBACK =
    'https://www.fab.com/social/complete/epic/?code=AUTHCODE&state=stateABC'

  beforeEach(() => {
    fetchMock = vi.fn()
    driver = new FetchFabLoginDriver(fetchMock as unknown as typeof fetch)
    jar = new InMemoryCookieJar()
    jar.captureFromResponse(
      new URL('https://www.epicgames.com/'),
      new Headers({ 'Set-Cookie': 'EPIC_SESSION_AP=epic-sess; Domain=.epicgames.com' })
    )
    session = {
      jar,
      ue4SessionReady: true,
      getCookieHeader: (host) => jar.getCookieHeader(new URL(`https://${host}/`))
    }
  })

  function redirectResponse(location: string, status = 302, cookies: string[] = []): Response {
    const h = new Headers({ Location: location })
    for (const c of cookies) h.append('Set-Cookie', c)
    return new Response(null, { status, headers: h })
  }

  function jsonResponse(body: unknown, status = 200, cookies: string[] = []): Response {
    const h = new Headers({ 'Content-Type': 'application/json' })
    for (const c of cookies) h.append('Set-Cookie', c)
    return new Response(JSON.stringify(body), { status, headers: h })
  }

  it('happy path: F1→F2→F3→F4→F5 produces a cookieHeader with fab_sessionid', async () => {
    // F1: 302 → Epic OAuth authorize URL
    fetchMock.mockResolvedValueOnce(redirectResponse(OAUTH_URL))
    // F2: 200
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 200 }))
    // F3: 200
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 200 }))
    // F4: 200 JSON with redirectUrl
    fetchMock.mockResolvedValueOnce(jsonResponse({ redirectUrl: FAB_CALLBACK }))
    // F5: 302 with fab_sessionid + fab_csrftoken Set-Cookie
    fetchMock.mockResolvedValueOnce(
      redirectResponse('https://www.fab.com/library', 302, [
        'fab_sessionid=fab-sess-val; Domain=.fab.com; Path=/',
        'fab_csrftoken=fab-csrf-val; Domain=.fab.com; Path=/'
      ])
    )

    const cookieHeader = await driver.login(session)

    expect(cookieHeader).toContain('fab_sessionid=fab-sess-val')
    expect(cookieHeader).toContain('fab_csrftoken=fab-csrf-val')

    // Verify the 5 URLs invoked, in order
    expect(fetchMock.mock.calls[0][0]).toBe(
      'https://www.fab.com/social/login/epic/?next=/library'
    )
    expect(fetchMock.mock.calls[1][0]).toBe('https://www.epicgames.com/id/api/authenticate')
    expect(fetchMock.mock.calls[2][0]).toContain(
      'https://www.epicgames.com/id/api/client/abc123def456?'
    )
    expect(fetchMock.mock.calls[3][0]).toContain('https://www.epicgames.com/id/api/redirect?')
    expect(fetchMock.mock.calls[3][0]).toContain('clientId=abc123def456')
    expect(fetchMock.mock.calls[3][0]).toContain('state=stateABC')
    expect(fetchMock.mock.calls[4][0]).toBe(FAB_CALLBACK)
  })

  it('never sends Authorization: bearer on any of F1-F5 (Fab dance is cookie-only)', async () => {
    fetchMock.mockResolvedValueOnce(redirectResponse(OAUTH_URL))
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 200 }))
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 200 }))
    fetchMock.mockResolvedValueOnce(jsonResponse({ redirectUrl: FAB_CALLBACK }))
    fetchMock.mockResolvedValueOnce(
      redirectResponse('https://www.fab.com/library', 302, [
        'fab_sessionid=v; Domain=.fab.com; Path=/'
      ])
    )

    await driver.login(session)

    for (const call of fetchMock.mock.calls) {
      const init = call[1] as RequestInit
      const headers = init.headers as Record<string, string>
      expect(headers.Authorization).toBeUndefined()
      expect(headers.authorization).toBeUndefined()
    }
  })

  it('F1 with 200 status (no redirect) throws f1-no-redirect', async () => {
    fetchMock.mockResolvedValueOnce(new Response('<html></html>', { status: 200 }))
    await expect(driver.login(session)).rejects.toMatchObject({
      name: 'FabHandshakeError',
      step: 'f1-no-redirect'
    })
  })

  it('F1 30x without Location header throws f1-no-redirect', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 302 }))
    await expect(driver.login(session)).rejects.toMatchObject({
      step: 'f1-no-redirect'
    })
  })

  it('F1 short-circuit: Location is already a fab.com URL with ?code= → skips to F5', async () => {
    // F1 short-circuits with a direct fab.com callback URL
    fetchMock.mockResolvedValueOnce(redirectResponse(FAB_CALLBACK))
    // F5: 302 with fab_sessionid
    fetchMock.mockResolvedValueOnce(
      redirectResponse('https://www.fab.com/library', 302, [
        'fab_sessionid=short-circuit; Domain=.fab.com; Path=/'
      ])
    )

    const cookieHeader = await driver.login(session)

    expect(cookieHeader).toContain('fab_sessionid=short-circuit')
    expect(fetchMock).toHaveBeenCalledTimes(2) // F1 + F5 only, NO F2/F3/F4
  })

  it('F2 401 throws epic-session-invalid', async () => {
    fetchMock.mockResolvedValueOnce(redirectResponse(OAUTH_URL))
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 401 }))
    await expect(driver.login(session)).rejects.toMatchObject({
      step: 'epic-session-invalid'
    })
  })

  it('F3 403 throws client-not-authorized', async () => {
    fetchMock.mockResolvedValueOnce(redirectResponse(OAUTH_URL))
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 200 }))
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 403 }))
    await expect(driver.login(session)).rejects.toMatchObject({
      step: 'client-not-authorized'
    })
  })

  it('F4 with redirectUrl pointing outside fab.com throws f4-unexpected-redirect', async () => {
    fetchMock.mockResolvedValueOnce(redirectResponse(OAUTH_URL))
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 200 }))
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 200 }))
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ redirectUrl: 'https://malicious.example/oops?code=x' })
    )
    await expect(driver.login(session)).rejects.toMatchObject({
      step: 'f4-unexpected-redirect'
    })
  })

  it('F5 succeeds but no fab_sessionid set → throws f5-no-sessionid', async () => {
    fetchMock.mockResolvedValueOnce(redirectResponse(OAUTH_URL))
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 200 }))
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 200 }))
    fetchMock.mockResolvedValueOnce(jsonResponse({ redirectUrl: FAB_CALLBACK }))
    fetchMock.mockResolvedValueOnce(
      redirectResponse('https://www.fab.com/?error_code=1', 302, [
        'fab_csrftoken=only-csrf; Domain=.fab.com; Path=/'
      ])
    )
    await expect(driver.login(session)).rejects.toMatchObject({
      step: 'f5-no-sessionid'
    })
  })

  it('sends Launcher UA + x-epic-* headers (including x-epic-duration) on every call', async () => {
    fetchMock.mockResolvedValueOnce(redirectResponse(OAUTH_URL))
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 200 }))
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 200 }))
    fetchMock.mockResolvedValueOnce(jsonResponse({ redirectUrl: FAB_CALLBACK }))
    fetchMock.mockResolvedValueOnce(
      redirectResponse('https://www.fab.com/library', 302, [
        'fab_sessionid=v; Domain=.fab.com; Path=/'
      ])
    )

    await driver.login(session)

    for (const call of fetchMock.mock.calls) {
      const headers = (call[1] as RequestInit).headers as Record<string, string>
      expect(headers['User-Agent']).toContain('ReHoarder/')
      expect(headers['x-epic-client-id']).toBe('undefined')
      expect(headers['x-epic-display-mode']).toBe('web')
      expect(headers['x-epic-platform']).toBe('WEB')
      // Fab silently rejects requests that omit x-epic-duration — send it on every call.
      expect(headers['x-epic-duration']).toMatch(/^\d+$/)
      expect(Number(headers['x-epic-duration'])).toBeGreaterThan(0)
    }
  })
})
