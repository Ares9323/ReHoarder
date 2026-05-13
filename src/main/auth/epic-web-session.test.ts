import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EpicWebSessionFactory, EpicWebSessionError } from './epic-web-session'

let fetchMock: ReturnType<typeof vi.fn>
let factory: EpicWebSessionFactory

beforeEach(() => {
  fetchMock = vi.fn()
  factory = new EpicWebSessionFactory(fetchMock as unknown as typeof fetch)
})

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  })
}

describe('EpicWebSessionFactory — Step E1 (exchange code)', () => {
  it('calls /account/api/oauth/exchange with bearer + Launcher UA, returns exchange code', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ code: 'EXCHANGE-32HEX', expires_in: 300 }))
    // Stub the remaining steps so create() resolves: we'll fully test them in later tasks.
    // For E1-only coverage we call the private requestExchangeCode via the factory's exposed
    // testing seam. Easiest: cast and call.
    const code = await (
      factory as unknown as { requestExchangeCode(token: string): Promise<string> }
    ).requestExchangeCode('the-bearer')
    expect(code).toBe('EXCHANGE-32HEX')

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe(
      'https://account-public-service-prod03.ol.epicgames.com/account/api/oauth/exchange'
    )
    expect(init.method).toBe('GET')
    expect(init.headers['Authorization']).toBe('bearer the-bearer')
    expect(init.headers['User-Agent']).toContain('EpicGamesLauncher')
  })

  it('throws EpicWebSessionError("exchange-failed") on 401', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ errorCode: 'unauthorized' }, 401))
    await expect(
      (factory as unknown as { requestExchangeCode(t: string): Promise<string> }).requestExchangeCode(
        'bad'
      )
    ).rejects.toMatchObject({ name: 'EpicWebSessionError', code: 'exchange-failed' } satisfies Partial<EpicWebSessionError>)
  })

  it('throws EpicWebSessionError("exchange-failed") on 500', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({}, 500))
    await expect(
      (factory as unknown as { requestExchangeCode(t: string): Promise<string> }).requestExchangeCode(
        'x'
      )
    ).rejects.toMatchObject({ code: 'exchange-failed' })
  })
})

function responseWithCookies(cookies: string[], status = 200, body: unknown = null): Response {
  const headers = new Headers()
  if (body !== null) headers.set('Content-Type', 'application/json')
  for (const c of cookies) headers.append('Set-Cookie', c)
  return new Response(body !== null ? JSON.stringify(body) : null, { status, headers })
}

describe('EpicWebSessionFactory — Step E2 (CSRF bootstrap)', () => {
  it('GETs /id/api/csrf with browser UA + login headers, captures XSRF-TOKEN into the jar', async () => {
    const { InMemoryCookieJar } = await import('../http/cookie-jar')
    const jar = new InMemoryCookieJar()
    fetchMock.mockResolvedValueOnce(
      responseWithCookies(['XSRF-TOKEN=tok123; Path=/; Domain=.epicgames.com'])
    )

    await (
      factory as unknown as { bootstrapCsrf(j: InstanceType<typeof InMemoryCookieJar>): Promise<void> }
    ).bootstrapCsrf(jar)

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://www.epicgames.com/id/api/csrf')
    expect(init.method).toBe('GET')
    expect(init.headers['User-Agent']).toContain('Chrome/')
    expect(init.headers['Referer']).toBe('https://www.epicgames.com/id/login')
    expect(init.headers['X-Epic-Event-Action']).toBe('login')
    expect(init.headers['X-Epic-Event-Category']).toBe('login')
    expect(init.headers['X-Epic-Strategy-Flags']).toBe('isolatedTestFlagEnabled=false')
    expect(init.headers['X-Requested-With']).toBe('XMLHttpRequest')
    expect(jar.getCookieValue(new URL('https://www.epicgames.com/'), 'XSRF-TOKEN')).toBe('tok123')
  })

  it('falls back to /account/v2/refresh-csrf + retries when first /id/api/csrf does not set XSRF-TOKEN', async () => {
    const { InMemoryCookieJar } = await import('../http/cookie-jar')
    const jar = new InMemoryCookieJar()
    // 1st call: /id/api/csrf — no XSRF-TOKEN cookie set
    fetchMock.mockResolvedValueOnce(responseWithCookies([]))
    // 2nd call: /account/v2/refresh-csrf — sets cookie
    fetchMock.mockResolvedValueOnce(
      responseWithCookies(['XSRF-TOKEN=fallback-tok; Domain=.epicgames.com'])
    )
    // 3rd call: retry /id/api/csrf — also sets cookie (or simply 200)
    fetchMock.mockResolvedValueOnce(
      responseWithCookies(['XSRF-TOKEN=fallback-tok; Domain=.epicgames.com'])
    )

    await (
      factory as unknown as { bootstrapCsrf(j: InstanceType<typeof InMemoryCookieJar>): Promise<void> }
    ).bootstrapCsrf(jar)

    expect(fetchMock.mock.calls[1][0]).toBe('https://www.epicgames.com/account/v2/refresh-csrf')
    expect(fetchMock.mock.calls[2][0]).toBe('https://www.epicgames.com/id/api/csrf')
    expect(jar.getCookieValue(new URL('https://www.epicgames.com/'), 'XSRF-TOKEN')).toBe(
      'fallback-tok'
    )
  })

  it('throws EpicWebSessionError("csrf-missing") when neither path sets XSRF-TOKEN', async () => {
    const { InMemoryCookieJar } = await import('../http/cookie-jar')
    const jar = new InMemoryCookieJar()
    fetchMock.mockResolvedValue(responseWithCookies([]))
    await expect(
      (factory as unknown as {
        bootstrapCsrf(j: InstanceType<typeof InMemoryCookieJar>): Promise<void>
      }).bootstrapCsrf(jar)
    ).rejects.toMatchObject({ name: 'EpicWebSessionError', code: 'csrf-missing' })
  })
})

describe('EpicWebSessionFactory — Step E3 (POST exchange)', () => {
  it('POSTs /id/api/exchange with X-XSRF-TOKEN + body, captures EPIC_SESSION_AP cookie', async () => {
    const { InMemoryCookieJar } = await import('../http/cookie-jar')
    const jar = new InMemoryCookieJar()
    jar.captureFromResponse(
      new URL('https://www.epicgames.com/'),
      new Headers({ 'Set-Cookie': 'XSRF-TOKEN=csrf-val; Domain=.epicgames.com' })
    )
    fetchMock.mockResolvedValueOnce(
      responseWithCookies(['EPIC_SESSION_AP=sess-val; Domain=.epicgames.com'])
    )

    await (
      factory as unknown as {
        postExchange(j: InstanceType<typeof InMemoryCookieJar>, code: string): Promise<void>
      }
    ).postExchange(jar, 'EXCHANGE-CODE')

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://www.epicgames.com/id/api/exchange')
    expect(init.method).toBe('POST')
    expect(init.headers['Content-Type']).toBe('application/x-www-form-urlencoded')
    expect(init.headers['X-XSRF-TOKEN']).toBe('csrf-val')
    expect(init.headers['Referer']).toBe('https://www.epicgames.com/id/login')
    expect(init.headers['User-Agent']).toContain('Chrome/')
    expect(init.headers['Cookie']).toContain('XSRF-TOKEN=csrf-val')
    expect(init.body).toBe('exchangeCode=EXCHANGE-CODE')
    expect(jar.getCookieValue(new URL('https://www.epicgames.com/'), 'EPIC_SESSION_AP')).toBe(
      'sess-val'
    )
  })

  it('throws EpicWebSessionError("exchange-rejected") on non-2xx', async () => {
    const { InMemoryCookieJar } = await import('../http/cookie-jar')
    const jar = new InMemoryCookieJar()
    jar.captureFromResponse(
      new URL('https://www.epicgames.com/'),
      new Headers({ 'Set-Cookie': 'XSRF-TOKEN=x; Domain=.epicgames.com' })
    )
    fetchMock.mockResolvedValueOnce(jsonResponse({ errorCode: 'invalid_grant' }, 403))
    await expect(
      (factory as unknown as {
        postExchange(j: InstanceType<typeof InMemoryCookieJar>, c: string): Promise<void>
      }).postExchange(jar, 'C')
    ).rejects.toMatchObject({ name: 'EpicWebSessionError', code: 'exchange-rejected' })
  })

  it('throws EpicWebSessionError("no-epic-session") when 200 but EPIC_SESSION_AP missing', async () => {
    const { InMemoryCookieJar } = await import('../http/cookie-jar')
    const jar = new InMemoryCookieJar()
    jar.captureFromResponse(
      new URL('https://www.epicgames.com/'),
      new Headers({ 'Set-Cookie': 'XSRF-TOKEN=x; Domain=.epicgames.com' })
    )
    fetchMock.mockResolvedValueOnce(responseWithCookies(['some_other_cookie=val']))
    await expect(
      (factory as unknown as {
        postExchange(j: InstanceType<typeof InMemoryCookieJar>, c: string): Promise<void>
      }).postExchange(jar, 'C')
    ).rejects.toMatchObject({ name: 'EpicWebSessionError', code: 'no-epic-session' })
  })
})

describe('EpicWebSessionFactory — create() integration (E1→E2→E3→E_V→E_H→E4)', () => {
  it('full chain happy path: all steps succeed, returns session with ue4SessionReady=true', async () => {
    // E1: exchange code
    fetchMock.mockResolvedValueOnce(jsonResponse({ code: 'CHAIN-CODE' }))
    // E2: CSRF bootstrap (single call)
    fetchMock.mockResolvedValueOnce(
      responseWithCookies(['XSRF-TOKEN=csrf-ok; Domain=.epicgames.com'])
    )
    // E3: POST exchange
    fetchMock.mockResolvedValueOnce(
      responseWithCookies(['EPIC_SESSION_AP=sess-ok; Domain=.epicgames.com'])
    )
    // E_V: GET /id/api/redirect? → JSON { sid: ... }
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ sid: 'sid-ok', exchangeCode: '', authorizationCode: '' })
    )
    // E_H: GET unrealengine.com/id/api/set-sid?sid=… → 204
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }))
    // E4: UE.com cosmos/auth
    fetchMock.mockResolvedValueOnce(
      responseWithCookies(['ue_session=ue-ok; Domain=.unrealengine.com'], 200, { ok: true })
    )

    const session = await factory.create('the-access-token')

    expect(session.ue4SessionReady).toBe(true)
    expect(typeof session.getCookieHeader).toBe('function')
    expect(session.getCookieHeader('www.epicgames.com')).toContain('EPIC_SESSION_AP=sess-ok')

    // Verify E_V and E_H were invoked with the right URLs
    expect(fetchMock.mock.calls[3][0]).toBe('https://www.epicgames.com/id/api/redirect?')
    expect(fetchMock.mock.calls[4][0]).toBe(
      'https://www.unrealengine.com/id/api/set-sid?sid=sid-ok'
    )
    expect(fetchMock.mock.calls[4][1].headers.Origin).toBe('https://www.epicgames.com')
  })

  it('E_V returns no sid: E_H is skipped, E4 still runs', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    // E1, E2, E3
    fetchMock.mockResolvedValueOnce(jsonResponse({ code: 'CHAIN-CODE' }))
    fetchMock.mockResolvedValueOnce(
      responseWithCookies(['XSRF-TOKEN=csrf-ok; Domain=.epicgames.com'])
    )
    fetchMock.mockResolvedValueOnce(
      responseWithCookies(['EPIC_SESSION_AP=sess-ok; Domain=.epicgames.com'])
    )
    // E_V: returns empty sid
    fetchMock.mockResolvedValueOnce(jsonResponse({ sid: '' }))
    // E4: cosmos/auth (NO E_H call between)
    fetchMock.mockResolvedValueOnce(
      responseWithCookies(['ue_session=ue-ok; Domain=.unrealengine.com'], 200, { ok: true })
    )

    const session = await factory.create('the-access-token')

    expect(session.ue4SessionReady).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(5) // E1+E2+E3+E_V+E4, no E_H
    expect(fetchMock.mock.calls[4][0]).toBe('https://www.unrealengine.com/api/cosmos/auth')
    warnSpy.mockRestore()
  })

  it('E4 failure tolerated: previous steps succeed, E4 returns 503, ue4SessionReady=false', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    fetchMock.mockResolvedValueOnce(jsonResponse({ code: 'CHAIN-CODE' }))
    fetchMock.mockResolvedValueOnce(
      responseWithCookies(['XSRF-TOKEN=csrf-ok; Domain=.epicgames.com'])
    )
    fetchMock.mockResolvedValueOnce(
      responseWithCookies(['EPIC_SESSION_AP=sess-ok; Domain=.epicgames.com'])
    )
    fetchMock.mockResolvedValueOnce(jsonResponse({ sid: 'sid-ok' }))
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }))
    // E4: 503
    fetchMock.mockResolvedValueOnce(jsonResponse({}, 503))

    const session = await factory.create('the-access-token')

    expect(session.ue4SessionReady).toBe(false)
    expect(session.getCookieHeader('www.epicgames.com')).toContain('EPIC_SESSION_AP=sess-ok')
    warnSpy.mockRestore()
  })

  it('E1 fails: throws EpicWebSessionError("exchange-failed")', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ errorCode: 'unauthorized' }, 401))

    await expect(factory.create('bad-token')).rejects.toMatchObject({
      name: 'EpicWebSessionError',
      code: 'exchange-failed'
    } satisfies Partial<EpicWebSessionError>)
  })
})

describe('EpicWebSessionFactory — Step E_V (fetch Epic sid)', () => {
  it('GETs /id/api/redirect? and returns sid from JSON body', async () => {
    const { InMemoryCookieJar } = await import('../http/cookie-jar')
    const jar = new InMemoryCookieJar()
    fetchMock.mockResolvedValueOnce(jsonResponse({ sid: 'the-sid', exchangeCode: '' }))

    const sid = await (
      factory as unknown as { fetchEpicSid(j: InstanceType<typeof InMemoryCookieJar>): Promise<string | null> }
    ).fetchEpicSid(jar)

    expect(sid).toBe('the-sid')
    expect(fetchMock.mock.calls[0][0]).toBe('https://www.epicgames.com/id/api/redirect?')
    expect(fetchMock.mock.calls[0][1].method).toBe('GET')
  })

  it('returns null when sid is empty string', async () => {
    const { InMemoryCookieJar } = await import('../http/cookie-jar')
    const jar = new InMemoryCookieJar()
    fetchMock.mockResolvedValueOnce(jsonResponse({ sid: '' }))

    const sid = await (
      factory as unknown as { fetchEpicSid(j: InstanceType<typeof InMemoryCookieJar>): Promise<string | null> }
    ).fetchEpicSid(jar)

    expect(sid).toBeNull()
  })

  it('returns null (no throw) on non-2xx response', async () => {
    const { InMemoryCookieJar } = await import('../http/cookie-jar')
    const jar = new InMemoryCookieJar()
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    fetchMock.mockResolvedValueOnce(jsonResponse({}, 401))

    const sid = await (
      factory as unknown as { fetchEpicSid(j: InstanceType<typeof InMemoryCookieJar>): Promise<string | null> }
    ).fetchEpicSid(jar)

    expect(sid).toBeNull()
    expect(warnSpy).toHaveBeenCalled()
    warnSpy.mockRestore()
  })
})

describe('EpicWebSessionFactory — Step E_H (UE set-sid)', () => {
  it('GETs unrealengine.com/id/api/set-sid?sid=… with Origin header', async () => {
    const { InMemoryCookieJar } = await import('../http/cookie-jar')
    const jar = new InMemoryCookieJar()
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }))

    await (
      factory as unknown as { setUeSid(j: InstanceType<typeof InMemoryCookieJar>, s: string): Promise<void> }
    ).setUeSid(jar, 'abc123')

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://www.unrealengine.com/id/api/set-sid?sid=abc123')
    expect(init.method).toBe('GET')
    expect(init.headers.Origin).toBe('https://www.epicgames.com')
  })

  it('URL-encodes the sid parameter', async () => {
    const { InMemoryCookieJar } = await import('../http/cookie-jar')
    const jar = new InMemoryCookieJar()
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }))

    await (
      factory as unknown as { setUeSid(j: InstanceType<typeof InMemoryCookieJar>, s: string): Promise<void> }
    ).setUeSid(jar, 'a/b+c=d')

    expect(fetchMock.mock.calls[0][0]).toBe(
      'https://www.unrealengine.com/id/api/set-sid?sid=a%2Fb%2Bc%3Dd'
    )
  })

  it('does not throw on network failure (tolerated)', async () => {
    const { InMemoryCookieJar } = await import('../http/cookie-jar')
    const jar = new InMemoryCookieJar()
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    fetchMock.mockRejectedValueOnce(new Error('ECONNRESET'))

    await expect(
      (factory as unknown as { setUeSid(j: InstanceType<typeof InMemoryCookieJar>, s: string): Promise<void> })
        .setUeSid(jar, 'sid')
    ).resolves.toBeUndefined()
    expect(warnSpy).toHaveBeenCalled()
    warnSpy.mockRestore()
  })
})

describe('EpicWebSessionFactory — Step E4 (UE.com bootstrap)', () => {
  it('GETs unrealengine.com/api/cosmos/auth, captures cookies, returns true on success', async () => {
    const { InMemoryCookieJar } = await import('../http/cookie-jar')
    const jar = new InMemoryCookieJar()
    fetchMock.mockResolvedValueOnce(
      responseWithCookies(['ue_session=abc; Domain=.unrealengine.com'], 200, { authenticated: true })
    )

    const ok = await (
      factory as unknown as {
        bootstrapUe4(j: InstanceType<typeof InMemoryCookieJar>): Promise<boolean>
      }
    ).bootstrapUe4(jar)

    expect(ok).toBe(true)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://www.unrealengine.com/api/cosmos/auth')
    // Epic web requests use the Launcher-style UA + x-epic-* headers, including cosmos/auth.
    expect(init.headers['User-Agent']).toContain('ReHoarder/')
    expect(init.headers['x-epic-client-id']).toBe('undefined')
    expect(init.headers['x-epic-duration']).toMatch(/^\d+$/)
    expect(jar.getCookieValue(new URL('https://www.unrealengine.com/'), 'ue_session')).toBe('abc')
  })

  it('returns false (no throw) on non-2xx HTTP response', async () => {
    const { InMemoryCookieJar } = await import('../http/cookie-jar')
    const jar = new InMemoryCookieJar()
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    fetchMock.mockResolvedValueOnce(jsonResponse({}, 500))

    const ok = await (
      factory as unknown as {
        bootstrapUe4(j: InstanceType<typeof InMemoryCookieJar>): Promise<boolean>
      }
    ).bootstrapUe4(jar)

    expect(ok).toBe(false)
    expect(warnSpy).toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it('returns false (no throw) when fetch itself rejects (network/DNS/TLS error)', async () => {
    const { InMemoryCookieJar } = await import('../http/cookie-jar')
    const jar = new InMemoryCookieJar()
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    fetchMock.mockRejectedValueOnce(new Error('ENOTFOUND'))

    const ok = await (
      factory as unknown as {
        bootstrapUe4(j: InstanceType<typeof InMemoryCookieJar>): Promise<boolean>
      }
    ).bootstrapUe4(jar)

    expect(ok).toBe(false)
    expect(warnSpy).toHaveBeenCalled()
    warnSpy.mockRestore()
  })
})
