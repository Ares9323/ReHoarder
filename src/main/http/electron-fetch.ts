/**
 * Electron-backed fetch adapter that issues HTTP requests through the
 * Chromium network stack instead of Node's built-in undici.
 *
 * Why: Cloudflare on www.fab.com fingerprints TLS handshakes (JA3/JA4)
 * and HTTP/2 SETTINGS frames. Node's TLS fingerprint is distinct from
 * Chromium's, so even a valid `cf_clearance` cookie obtained via a
 * BrowserWindow is rejected (HTTP 403) when replayed via `fetch()`.
 * Using `Electron.net.fetch` keeps the Chromium fingerprint that the
 * clearance cookie was bound to.
 *
 * Caveat: `useSessionCookies: false` (the default) means cookies are
 * NOT auto-injected from the partition jar — callers must continue to
 * pass an explicit `Cookie:` header built from our InMemoryCookieJar.
 * This preserves the existing cookie-jar abstraction; the session is
 * only here to share the TLS fingerprint and any cf_clearance state.
 */

import type { CookieJar } from './cookie-jar'

export interface ElectronFetchOptions {
  /**
   * When true, Chromium reads cookies from / writes Set-Cookie into the
   * partition cookie store, the way a normal browser navigation would.
   * The caller MUST pre-populate the partition with whatever cookies are
   * needed (see {@link syncJarIntoSession}). Default: false (caller passes
   * an explicit `Cookie:` header per request and stores Set-Cookie itself).
   */
  useSessionCookies?: boolean
}

export async function createElectronFetch(
  partition: string,
  opts: ElectronFetchOptions = {}
): Promise<typeof fetch> {
  const { net, session } = await import('electron')
  const sess = session.fromPartition(partition)
  const useSessionCookies = opts.useSessionCookies ?? false

  return async (input, init) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as Request).url

    // Electron.net.fetch rejects (throws "Redirect was cancelled") when
    // a 3xx response is received with redirect: 'manual'. We need the
    // 3xx + Location intact for the F1/F5 handshake steps, so for that
    // mode we drop down to net.request and synthesize a Response from
    // the `redirect` event.
    if ((init as RequestInit | undefined)?.redirect === 'manual') {
      return fetchWithManualRedirect(url, init as RequestInit, sess, useSessionCookies)
    }

    const fetchOpts: Electron.ClientRequestConstructorOptions & RequestInit = {
      ...(init as RequestInit),
      session: sess,
      useSessionCookies
    } as never
    return (await net.fetch(url, fetchOpts as never)) as Response
  }
}

async function fetchWithManualRedirect(
  url: string,
  init: RequestInit,
  sess: Electron.Session,
  useSessionCookies: boolean
): Promise<Response> {
  const { net } = await import('electron')
  return new Promise<Response>((resolve, reject) => {
    const req = net.request({
      url,
      method: (init.method as string | undefined) ?? 'GET',
      session: sess,
      redirect: 'manual',
      useSessionCookies
    })

    const headers = (init.headers ?? {}) as Record<string, string>
    for (const [k, v] of Object.entries(headers)) {
      req.setHeader(k, v)
    }

    let settled = false
    const settle = (fn: () => void): void => {
      if (settled) return
      settled = true
      fn()
    }

    req.on('redirect', (statusCode, _method, redirectUrl, responseHeaders) => {
      const h = headersFromIncoming(responseHeaders)
      if (!h.has('location')) h.set('location', redirectUrl)
      req.abort()
      settle(() => resolve(new Response(null, { status: statusCode, headers: h })))
    })

    req.on('response', (response) => {
      const h = headersFromIncoming(response.headers as Record<string, string | string[]>)
      const chunks: Buffer[] = []
      response.on('data', (chunk: Buffer) => chunks.push(chunk))
      response.on('end', () => {
        const body = chunks.length > 0 ? Buffer.concat(chunks) : null
        settle(() =>
          resolve(new Response(body, { status: response.statusCode, headers: h }))
        )
      })
      response.on('error', (err) => settle(() => reject(err)))
    })

    req.on('error', (err) => settle(() => reject(err)))

    if (init.body) {
      req.write(init.body as string)
    }
    req.end()
  })
}

function headersFromIncoming(src: Record<string, string | string[]>): Headers {
  const h = new Headers()
  for (const [name, value] of Object.entries(src)) {
    if (Array.isArray(value)) {
      for (const v of value) h.append(name, v)
    } else if (typeof value === 'string') {
      h.append(name, value)
    }
  }
  return h
}

/**
 * Mirror any cookies live in the Electron session jar (for a given host)
 * back into the InMemoryCookieJar, so getCookieValue / getCookieHeader
 * reflect the post-request state. Useful after redirects that
 * Electron followed internally and that our jar never observed.
 */
export async function syncSessionCookiesIntoJar(
  partition: string,
  domains: string[],
  jar: CookieJar
): Promise<void> {
  const { session } = await import('electron')
  const sess = session.fromPartition(partition)
  for (const domain of domains) {
    const cookies = await sess.cookies.get({ domain })
    for (const c of cookies) {
      const cookieDomain = c.domain ?? ''
      const host = cookieDomain.startsWith('.') ? cookieDomain.slice(1) : cookieDomain
      if (!host || !c.name) continue
      const setCookie = cookieDomain
        ? `${c.name}=${c.value}; Domain=${cookieDomain}; Path=${c.path || '/'}`
        : `${c.name}=${c.value}; Path=${c.path || '/'}`
      const headers = new Headers()
      headers.append('Set-Cookie', setCookie)
      jar.captureFromResponse(new URL(`https://${host}/`), headers)
    }
  }
}

/**
 * Copy every cookie in the in-memory jar into the partition's cookie store
 * so that `useSessionCookies: true` requests can pick them up natively.
 * Returns the number of cookies successfully written. Cookies Electron
 * rejects (malformed values, etc.) are skipped silently.
 */
export async function syncJarIntoSession(
  jar: CookieJar,
  sess: Electron.Session
): Promise<number> {
  let count = 0
  for (const { suffix, name, value } of jar.entries()) {
    const isHostBound = !suffix.startsWith('.')
    const host = isHostBound ? suffix : suffix.slice(1)
    const url = `https://${host}/`
    try {
      await sess.cookies.set({
        url,
        name,
        value,
        domain: isHostBound ? undefined : suffix,
        path: '/',
        secure: true,
        sameSite: 'no_restriction'
      })
      count++
    } catch {
      // ignore malformed cookies
    }
  }
  return count
}
