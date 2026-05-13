import { LAUNCHER_UA, EPIC_WEB_HEADERS } from '../http/user-agents'
import type { EpicWebSession } from '../auth/epic-web-session'
import type { CookieJar } from '../http/cookie-jar'
import { syncJarIntoSession } from '../http/electron-fetch'

export interface FabSession {
  cookieHeader: string
}

export type FabHandshakeStep =
  | 'f1-no-redirect'
  | 'epic-session-invalid'
  | 'client-not-authorized'
  | 'f4-unexpected-redirect'
  | 'f5-no-sessionid'
  | 'unknown'

export class FabHandshakeError extends Error {
  constructor(
    readonly step: FabHandshakeStep,
    message: string
  ) {
    super(message)
    this.name = 'FabHandshakeError'
  }
}

const FAB_LOGIN_ENTRY = 'https://www.fab.com/social/login/epic/?next=/library'
const FAB_BASE_URL = new URL('https://www.fab.com/')

/**
 * Interface boundary that lets tests replace the real fetch-driven
 * implementation with a deterministic mock. The default implementation
 * uses {@link FetchFabLoginDriver}, which runs the F1-F5 Fab OAuth dance
 * over `fetch`.
 */
export interface FabLoginDriver {
  /**
   * Run the F1-F5 Fab OAuth dance and return a Cookie header string with
   * the established Fab session cookies (`fab_sessionid`, `fab_csrftoken`,
   * `cf_clearance`, etc.) plus any other state Fab placed on `.fab.com`.
   */
  login(epicSession: EpicWebSession, onLog?: (msg: string) => void): Promise<string>
}

export class FabSessionClient {
  constructor(private readonly driver: FabLoginDriver) {}

  async establishSession(
    accessToken: string,
    epicSession: EpicWebSession,
    onLog: (msg: string) => void = () => {}
  ): Promise<FabSession> {
    // accessToken is not needed by the Fab dance itself — F1-F5 are entirely
    // cookie-driven, with no `Authorization: bearer` header on any of the
    // five calls. The argument is kept on the signature for API stability
    // and possible future use by other Fab endpoints.
    void accessToken
    const cookieHeader = await this.driver.login(epicSession, onLog)
    return { cookieHeader }
  }
}

interface OAuthParams {
  clientId: string
  redirectUri: string
  responseType: string
  scope: string
  state: string
}

/**
 * Real driver that performs the Fab login as a 5-step OAuth dance:
 *
 *   F1: GET fab.com/social/login/epic/?next=/library  (manual redirect)
 *        → captures the Epic /id/api/authorize URL from the Location header
 *   F2: GET epicgames.com/id/api/authenticate
 *        → 200 confirms the Epic web session is still valid
 *   F3: GET epicgames.com/id/api/client/<clientId>?redirectUrl=…
 *        → 200 confirms Fab is an authorized OAuth client for this user
 *   F4: GET epicgames.com/id/api/redirect?<params>&clientId=<id>&state=<s>
 *        → JSON { redirectUrl: "https://www.fab.com/..." }
 *   F5: GET <redirectUrl>  (manual redirect — cookies are on the 302 itself)
 *        → sets fab_sessionid + fab_csrftoken on .fab.com
 *
 * **No `Authorization: bearer` on any of F1-F5** — the whole dance is
 * cookie-driven; the bearer is only used by subsequent /e/* API calls
 * (FabClient) and by E1 in EpicWebSessionFactory.
 *
 * The fetch implementation is expected to:
 *  - use the Chromium TLS stack (so cf_clearance is honored)
 *  - support `redirect: 'manual'` (so F1 and F5 can observe the 30x response
 *    with Set-Cookie headers intact)
 *  - NOT auto-inject cookies from any partition — this driver passes the
 *    `Cookie:` header explicitly from the EpicWebSession's cookie jar.
 */
/**
 * Driver-level monotonic clock used to populate the `x-epic-duration` header
 * (milliseconds since module load, with a 7-second head start so the first
 * request doesn't read as zero). Fab silently rejects requests that omit
 * this header — the `/?error_code=1` redirect on F5 disappears once it is
 * present.
 */
const DRIVER_START_MS = Date.now() - 7000

/**
 * Loader for an Electron Session that owns the partition cookie jar the
 * Fab dance should use. When provided, the driver behaves like a real
 * browser navigation:
 *
 *   1. Before F1 it transfers our in-memory cookie jar into the partition,
 *      so Chromium will see them on every request.
 *   2. F1-F5 are issued with `useSessionCookies: true` (configured on the
 *      `fetchImpl`), letting Chromium read/write cookies natively along
 *      the redirect chain — including the intermediate Set-Cookie headers
 *      that `net.request` would otherwise swallow.
 *   3. After F5 the driver reads the final .fab.com cookies from the
 *      partition and assembles the `Cookie:` header for downstream Fab
 *      API calls.
 *
 * When `null`, the driver falls back to the pure-jar behavior used by
 * unit tests: every request gets an explicit `Cookie:` header built from
 * the jar, and the final cookies are read from the jar (assuming the
 * mocked fetch wrote them via `Set-Cookie` response headers).
 */
export type FabSessionLoader = () => Promise<Electron.Session>

export class FetchFabLoginDriver implements FabLoginDriver {
  constructor(
    private readonly fetchImpl: typeof fetch,
    private readonly sessionLoader: FabSessionLoader | null = null,
    private readonly userAgent: string = LAUNCHER_UA
  ) {}

  async login(
    epicSession: EpicWebSession,
    onLog: (msg: string) => void = () => {}
  ): Promise<string> {
    const jar = epicSession.jar

    const sess = this.sessionLoader ? await this.sessionLoader() : null
    if (sess) {
      const transferred = await syncJarIntoSession(jar, sess)
      onLog(`Fab driver: transferred ${transferred} jar cookies to partition`)
    }

    const preF1Csrf = jar.getCookieValue(FAB_BASE_URL, 'fab_csrftoken')
    onLog(
      `Fab driver: pre-F1 fab_csrftoken=${preF1Csrf ? preF1Csrf.slice(0, 8) + '…' : 'MISSING'}`
    )

    // F1 — discover the Epic OAuth URL. Send only the default headers
    // (UA + x-epic-* + jar Cookie). No Accept / Referer / X-Requested-With.
    const f1 = await this.fetchImpl(FAB_LOGIN_ENTRY, {
      method: 'GET',
      redirect: 'manual',
      headers: this.headersFor(jar, FAB_LOGIN_ENTRY)
    })
    const f1SetCookies = readSetCookies(f1.headers)
    jar.captureFromResponse(new URL(FAB_LOGIN_ENTRY), f1.headers)
    onLog(
      `Fab driver: F1 status=${f1.status}, set ${f1SetCookies.length} cookies` +
        (f1SetCookies.length
          ? ` (${f1SetCookies.map((c) => c.split('=')[0]).join(',')})`
          : '')
    )
    const postF1Csrf = jar.getCookieValue(FAB_BASE_URL, 'fab_csrftoken')
    if (preF1Csrf !== postF1Csrf) {
      onLog(
        `Fab driver: ⚠ fab_csrftoken changed after F1 ` +
          `(${preF1Csrf?.slice(0, 8) ?? 'none'}… → ${postF1Csrf?.slice(0, 8) ?? 'none'}…)`
      )
    }

    if (f1.status < 300 || f1.status >= 400) {
      throw new FabHandshakeError(
        'f1-no-redirect',
        `F1 /social/login/epic/ expected 30x, got ${f1.status}`
      )
    }
    const location = f1.headers.get('location') ?? f1.headers.get('Location')
    if (!location) {
      throw new FabHandshakeError(
        'f1-no-redirect',
        `F1 /social/login/epic/ ${f1.status} response had no Location header`
      )
    }
    const oauthUrl = new URL(location, FAB_LOGIN_ENTRY)

    // Short-circuit: Epic may immediately bounce back to Fab with ?code=…
    // when the session is already trusted. Skip F2-F4 in that case.
    if (oauthUrl.hostname === 'www.fab.com' && oauthUrl.searchParams.has('code')) {
      onLog('Fab driver: F1 short-circuit detected, jumping to F5')
      return await this.runF5(jar, sess, oauthUrl.toString(), onLog)
    }

    if (!oauthUrl.hostname.endsWith('epicgames.com')) {
      throw new FabHandshakeError(
        'f1-no-redirect',
        `F1 redirected to unexpected host ${oauthUrl.hostname}`
      )
    }

    const oauthParams = this.extractOAuthParams(oauthUrl)
    onLog(
      `Fab driver: F1 OK (clientId=${oauthParams.clientId.slice(0, 8)}…, ` +
        `state=${oauthParams.state.slice(0, 12)}…)`
    )

    // F2 — verify Epic session is valid. No extra headers needed.
    const F2_URL = 'https://www.epicgames.com/id/api/authenticate'
    const f2 = await this.fetchImpl(F2_URL, {
      method: 'GET',
      headers: this.headersFor(jar, F2_URL)
    })
    jar.captureFromResponse(new URL(F2_URL), f2.headers)
    if (f2.status === 401 || f2.status === 403) {
      throw new FabHandshakeError(
        'epic-session-invalid',
        `F2 /id/api/authenticate returned ${f2.status} — Epic web session rejected`
      )
    }
    if (!f2.ok) {
      throw new FabHandshakeError('unknown', `F2 /id/api/authenticate returned ${f2.status}`)
    }
    onLog('Fab driver: F2 OK')

    // F3 — verify Fab client is authorized
    const f3Params = new URLSearchParams()
    f3Params.append('redirectUrl', oauthParams.redirectUri)
    f3Params.append('responseType', oauthParams.responseType)
    f3Params.append('scope', oauthParams.scope)
    const f3Url = `https://www.epicgames.com/id/api/client/${encodeURIComponent(oauthParams.clientId)}?${f3Params}`
    const f3 = await this.fetchImpl(f3Url, {
      method: 'GET',
      headers: this.headersFor(jar, f3Url)
    })
    jar.captureFromResponse(new URL(f3Url), f3.headers)
    if (f3.status === 403) {
      throw new FabHandshakeError(
        'client-not-authorized',
        'F3 /id/api/client returned 403 — please visit fab.com in a browser to authorize the app'
      )
    }
    if (!f3.ok) {
      throw new FabHandshakeError('unknown', `F3 /id/api/client returned ${f3.status}`)
    }
    onLog('Fab driver: F3 OK')

    // F4 — get Fab callback URL
    const f4Params = new URLSearchParams()
    f4Params.append('redirectUrl', oauthParams.redirectUri)
    f4Params.append('responseType', oauthParams.responseType)
    f4Params.append('scope', oauthParams.scope)
    f4Params.append('clientId', oauthParams.clientId)
    f4Params.append('state', oauthParams.state)
    const f4Url = `https://www.epicgames.com/id/api/redirect?${f4Params}`
    const f4 = await this.fetchImpl(f4Url, {
      method: 'GET',
      headers: this.headersFor(jar, f4Url)
    })
    jar.captureFromResponse(new URL(f4Url), f4.headers)
    if (!f4.ok) {
      throw new FabHandshakeError('unknown', `F4 /id/api/redirect returned ${f4.status}`)
    }
    let f4Body: { redirectUrl?: string }
    try {
      f4Body = (await f4.json()) as { redirectUrl?: string }
    } catch {
      throw new FabHandshakeError(
        'f4-unexpected-redirect',
        'F4 /id/api/redirect returned non-JSON body'
      )
    }
    if (!f4Body.redirectUrl) {
      throw new FabHandshakeError(
        'f4-unexpected-redirect',
        'F4 /id/api/redirect JSON missing redirectUrl field'
      )
    }
    const fabCallback = new URL(f4Body.redirectUrl)
    if (fabCallback.hostname !== 'www.fab.com') {
      throw new FabHandshakeError(
        'f4-unexpected-redirect',
        `F4 redirectUrl host is ${fabCallback.hostname} (expected www.fab.com)`
      )
    }
    onLog(`Fab driver: F4 OK, hopping to Fab callback ${fabCallback.pathname}`)

    return await this.runF5(jar, sess, f4Body.redirectUrl, onLog)
  }

  /**
   * F5 — land on Fab's social/complete callback. Set-Cookie for the .fab.com
   * session cookies is on this 302 itself, so we MUST use `redirect: 'manual'`
   * to observe the response before Chromium swallows it on a follow.
   */
  private async runF5(
    jar: CookieJar,
    sess: Electron.Session | null,
    url: string,
    onLog: (msg: string) => void
  ): Promise<string> {
    const preF5Csrf = jar.getCookieValue(FAB_BASE_URL, 'fab_csrftoken')
    const urlObj = new URL(url)
    const stateOnF5 = urlObj.searchParams.get('state')
    onLog(
      `Fab driver: pre-F5 fab_csrftoken=${preF5Csrf?.slice(0, 8) ?? 'MISSING'}…, ` +
        `F5 url state=${stateOnF5?.slice(0, 12) ?? 'MISSING'}…`
    )

    // F5 needs no extra headers either — just the default UA + x-epic-* + jar cookie.
    const f5 = await this.fetchImpl(url, {
      method: 'GET',
      redirect: 'manual',
      headers: this.headersFor(jar, url)
    })
    const f5SetCookies = readSetCookies(f5.headers)
    jar.captureFromResponse(new URL(url), f5.headers)
    const f5Location = f5.headers.get('location') ?? f5.headers.get('Location')
    onLog(
      `Fab driver: F5 status=${f5.status}, location=${f5Location ?? '<none>'}, ` +
        `set ${f5SetCookies.length} cookies` +
        (f5SetCookies.length
          ? ` (${f5SetCookies.map((c) => c.split('=')[0]).join(',')})`
          : '')
    )

    if (f5.status !== 200 && f5.status !== 302 && f5.status !== 303 && f5.status !== 301) {
      throw new FabHandshakeError(
        'f5-no-sessionid',
        `F5 callback returned ${f5.status} (expected 200/302)`
      )
    }

    // Final cookies: when a real Electron session is attached we trust the
    // partition store (Chromium has tracked everything natively); when only
    // a jar is available (tests) we read from there.
    if (sess) {
      const fabCookies = await sess.cookies.get({ domain: 'fab.com' })
      const hasSession = fabCookies.some((c) => c.name === 'fab_sessionid')
      if (!hasSession) {
        const names = fabCookies.map((c) => c.name).join(',') || 'none'
        throw new FabHandshakeError(
          'f5-no-sessionid',
          `F5 finished without fab_sessionid (partition cookies: ${names})`
        )
      }
      const cookieHeader = fabCookies.map((c) => `${c.name}=${c.value}`).join('; ')
      onLog(`Fab driver: F5 OK, ${fabCookies.length} .fab.com cookies from partition`)
      return cookieHeader
    }

    const hasSession = jar.getCookieValue(FAB_BASE_URL, 'fab_sessionid')
    if (!hasSession) {
      const present = jar.getCookieHeader(FAB_BASE_URL)
      throw new FabHandshakeError(
        'f5-no-sessionid',
        `F5 finished without fab_sessionid (cookies: ${present || 'none'})`
      )
    }
    const cookieHeader = jar.getCookieHeader(FAB_BASE_URL)
    onLog(`Fab driver: F5 OK, ${cookieHeader.split(';').length} .fab.com cookies`)
    return cookieHeader
  }

  private extractOAuthParams(oauthUrl: URL): OAuthParams {
    const clientId = oauthUrl.searchParams.get('client_id')
    const redirectUri = oauthUrl.searchParams.get('redirect_uri')
    const responseType = oauthUrl.searchParams.get('response_type')
    const scope = oauthUrl.searchParams.get('scope')
    const state = oauthUrl.searchParams.get('state')
    if (!clientId || !redirectUri || !responseType || !scope || !state) {
      const missing = [
        ['client_id', clientId],
        ['redirect_uri', redirectUri],
        ['response_type', responseType],
        ['scope', scope],
        ['state', state]
      ]
        .filter(([, v]) => !v)
        .map(([k]) => k)
        .join(', ')
      throw new FabHandshakeError(
        'f1-no-redirect',
        `F1 OAuth URL missing required params: ${missing}`
      )
    }
    return { clientId, redirectUri, responseType, scope, state }
  }

  private headersFor(
    jar: CookieJar,
    url: string,
    extra: Record<string, string> = {}
  ): Record<string, string> {
    return {
      'User-Agent': this.userAgent,
      ...EPIC_WEB_HEADERS,
      'x-epic-duration': String(Date.now() - DRIVER_START_MS),
      Cookie: jar.getCookieHeader(new URL(url)),
      ...extra
    }
  }
}

function readSetCookies(headers: Headers): string[] {
  const getSetCookie = (headers as Headers & { getSetCookie?: () => string[] }).getSetCookie
  if (typeof getSetCookie === 'function') {
    const raw = getSetCookie.call(headers)
    if (raw.length > 0) return raw
  }
  const combined = headers.get('set-cookie')
  if (!combined) return []
  return combined.split(/,(?=\s*[A-Za-z0-9_-]+=)/)
}
