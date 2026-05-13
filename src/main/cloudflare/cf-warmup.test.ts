import { describe, it, expect, beforeEach } from 'vitest'
import { injectCookies, NoopCloudflareWarmer } from './cf-warmup'
import { InMemoryCookieJar } from '../http/cookie-jar'

let jar: InMemoryCookieJar

beforeEach(() => {
  jar = new InMemoryCookieJar()
})

describe('injectCookies', () => {
  it('injects cf_clearance with .fab.com domain into the jar', () => {
    injectCookies(jar, [
      { name: 'cf_clearance', value: 'TOKEN123', domain: '.fab.com', path: '/' }
    ])
    expect(jar.getCookieValue(new URL('https://www.fab.com/'), 'cf_clearance')).toBe('TOKEN123')
  })

  it('injects host-bound cookies (no domain) onto the request host', () => {
    injectCookies(jar, [{ name: 'EPIC_NONCE', value: 'abc', domain: 'www.epicgames.com', path: '/' }])
    expect(
      jar.getCookieValue(new URL('https://www.epicgames.com/'), 'EPIC_NONCE')
    ).toBe('abc')
  })

  it('injects multiple cookies in a single call', () => {
    injectCookies(jar, [
      { name: 'cf_clearance', value: 'one', domain: '.epicgames.com', path: '/' },
      { name: '__cf_bm', value: 'two', domain: '.epicgames.com', path: '/' },
      { name: 'EPIC_SESSION_AP', value: 'three', domain: '.epicgames.com', path: '/' }
    ])
    const header = jar.getCookieHeader(new URL('https://www.epicgames.com/id/login'))
    expect(header).toContain('cf_clearance=one')
    expect(header).toContain('__cf_bm=two')
    expect(header).toContain('EPIC_SESSION_AP=three')
  })

  it('skips cookies with empty name', () => {
    injectCookies(jar, [{ name: '', value: 'x', domain: '.fab.com', path: '/' }])
    expect(jar.getCookieHeader(new URL('https://www.fab.com/'))).toBe('')
  })

  it('skips cookies with empty/missing domain (cannot route)', () => {
    injectCookies(jar, [{ name: 'orphan', value: 'x', path: '/' }])
    expect(jar.getCookieHeader(new URL('https://www.fab.com/'))).toBe('')
  })

  it('exposes injected fab cookies to a www.fab.com request', () => {
    injectCookies(jar, [
      { name: 'cf_clearance', value: 'fab-cf', domain: '.fab.com', path: '/' },
      { name: '__cf_bm', value: 'fab-bm', domain: 'www.fab.com', path: '/' }
    ])
    const header = jar.getCookieHeader(new URL('https://www.fab.com/social/login/epic/'))
    expect(header).toContain('cf_clearance=fab-cf')
    expect(header).toContain('__cf_bm=fab-bm')
  })
})

describe('NoopCloudflareWarmer', () => {
  it('does not touch the jar', async () => {
    const w = new NoopCloudflareWarmer()
    await w.warmupInto(jar)
    expect(jar.getCookieHeader(new URL('https://www.fab.com/'))).toBe('')
  })
})
