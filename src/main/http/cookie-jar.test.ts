import { describe, it, expect, beforeEach } from 'vitest'
import { InMemoryCookieJar } from './cookie-jar'

function responseWithCookies(cookies: string[]): Response {
  const headers = new Headers()
  for (const c of cookies) headers.append('Set-Cookie', c)
  return new Response(null, { status: 200, headers })
}

let jar: InMemoryCookieJar
beforeEach(() => {
  jar = new InMemoryCookieJar()
})

describe('InMemoryCookieJar', () => {
  it('captures a single cookie and returns it in the Cookie header', () => {
    jar.captureFromResponse(
      new URL('https://www.fab.com/x'),
      responseWithCookies(['sessionid=abc; Path=/']).headers
    )
    expect(jar.getCookieHeader(new URL('https://www.fab.com/y'))).toBe('sessionid=abc')
  })

  it('supports multiple Set-Cookie headers on one response', () => {
    jar.captureFromResponse(
      new URL('https://www.fab.com/'),
      responseWithCookies([
        'csrftoken=tk; Path=/',
        'sessionid=xyz; Path=/; HttpOnly'
      ]).headers
    )
    const header = jar.getCookieHeader(new URL('https://www.fab.com/'))
    expect(header).toContain('csrftoken=tk')
    expect(header).toContain('sessionid=xyz')
  })

  it('matches Domain=.fab.com against www.fab.com (suffix with leading dot)', () => {
    jar.captureFromResponse(
      new URL('https://login.fab.com/'),
      responseWithCookies(['sessionid=zz; Domain=.fab.com; Path=/']).headers
    )
    expect(jar.getCookieHeader(new URL('https://www.fab.com/'))).toBe('sessionid=zz')
  })

  it('without Domain attribute, scopes the cookie to the exact request host only', () => {
    jar.captureFromResponse(
      new URL('https://www.epicgames.com/'),
      responseWithCookies(['XSRF-TOKEN=xxx; Path=/']).headers
    )
    expect(jar.getCookieHeader(new URL('https://www.epicgames.com/x'))).toBe('XSRF-TOKEN=xxx')
    // different host: no leak
    expect(jar.getCookieHeader(new URL('https://www.fab.com/'))).toBe('')
  })

  it('last write wins for same (host, name)', () => {
    const url = new URL('https://www.fab.com/')
    jar.captureFromResponse(url, responseWithCookies(['k=1']).headers)
    jar.captureFromResponse(url, responseWithCookies(['k=2']).headers)
    expect(jar.getCookieHeader(url)).toBe('k=2')
  })

  it('rejects a Set-Cookie whose Domain is not a suffix of the request host', () => {
    jar.captureFromResponse(
      new URL('https://www.fab.com/'),
      responseWithCookies(['evil=1; Domain=.evil.com; Path=/']).headers
    )
    expect(jar.getCookieHeader(new URL('https://www.evil.com/'))).toBe('')
  })

  it('rejects a Set-Cookie whose Domain is a public single-label TLD', () => {
    jar.captureFromResponse(
      new URL('https://www.fab.com/'),
      responseWithCookies(['evil=1; Domain=.com; Path=/']).headers
    )
    expect(jar.getCookieHeader(new URL('https://www.fab.com/'))).toBe('')
  })

  it('getCookieValue returns a single named cookie value', () => {
    jar.captureFromResponse(
      new URL('https://www.epicgames.com/'),
      responseWithCookies(['XSRF-TOKEN=abc123', 'EPIC_SESSION_AP=zzz']).headers
    )
    expect(jar.getCookieValue(new URL('https://www.epicgames.com/'), 'XSRF-TOKEN')).toBe('abc123')
    expect(jar.getCookieValue(new URL('https://www.epicgames.com/'), 'missing')).toBeUndefined()
  })
})
