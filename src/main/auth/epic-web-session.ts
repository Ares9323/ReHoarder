import { InMemoryCookieJar, type CookieJar } from '../http/cookie-jar'
import { EPIC_USER_AGENT } from '../vault/user-agent'
import { BROWSER_UA, LAUNCHER_UA, EPIC_WEB_HEADERS } from '../http/user-agents'
import type { CloudflareWarmer } from '../cloudflare/cf-warmup'
import { NoopCloudflareWarmer } from '../cloudflare/cf-warmup'

// The `x-epic-duration` header tracks elapsed ms since module load. The
// Epic web stack expects it on every authenticated request (with a small
// head start so the first call doesn't read as zero); without it some
// endpoints (UE.com / Fab) silently reject requests.
const EPIC_WEB_SESSION_START_MS = Date.now() - 7000
function epicDurationHeader(): string {
  return String(Date.now() - EPIC_WEB_SESSION_START_MS)
}

export interface EpicWebSession {
  readonly jar: CookieJar
  readonly ue4SessionReady: boolean
  getCookieHeader(host: string): string
}

export type EpicWebSessionErrorCode =
  | 'exchange-failed'
  | 'csrf-missing'
  | 'exchange-rejected'
  | 'no-epic-session'

export class EpicWebSessionError extends Error {
  constructor(
    readonly code: EpicWebSessionErrorCode,
    message: string
  ) {
    super(message)
    this.name = 'EpicWebSessionError'
  }
}

const EXCHANGE_ENDPOINT =
  'https://account-public-service-prod03.ol.epicgames.com/account/api/oauth/exchange'
const EXCHANGE_POST_ENDPOINT = 'https://www.epicgames.com/id/api/exchange'
const CSRF_ENDPOINT = 'https://www.epicgames.com/id/api/csrf'
const CSRF_REFRESH_ENDPOINT = 'https://www.epicgames.com/account/v2/refresh-csrf'
const EPIC_LOGIN_REFERER = 'https://www.epicgames.com/id/login'
// After the Epic /id/api/exchange step, the web protocol exposes a GET
// /id/api/redirect? (empty query) that returns JSON { sid, exchangeCode,
// authorizationCode } — used to grab the `sid` the next step needs (any
// of the three fields may be empty).
const EPIC_REDIRECT_ENDPOINT = 'https://www.epicgames.com/id/api/redirect?'
// set-sid is the unrealengine.com handoff that completes the cross-domain
// session. It lives on unrealengine.com (NOT epicgames.com) and expects an
// Origin header pointing back to epicgames.com.
const UE_SET_SID_ENDPOINT = 'https://www.unrealengine.com/id/api/set-sid'
const COSMOS_AUTH_ENDPOINT = 'https://www.unrealengine.com/api/cosmos/auth'

export class EpicWebSessionFactory {
  constructor(
    private readonly fetchImpl: typeof fetch = globalThis.fetch,
    private readonly jarFactory: () => CookieJar = () => new InMemoryCookieJar(),
    private readonly cfWarmer: CloudflareWarmer = new NoopCloudflareWarmer()
  ) {}

  async create(
    accessToken: string,
    onLog: (msg: string) => void = () => {}
  ): Promise<EpicWebSession> {
    const jar = this.jarFactory()
    await this.cfWarmer.warmupInto(jar, onLog)
    const code = await this.requestExchangeCode(accessToken)
    await this.bootstrapCsrf(jar)
    await this.postExchange(jar, code)
    const sid = await this.fetchEpicSid(jar)
    if (sid) await this.setUeSid(jar, sid)
    const ue4SessionReady = await this.bootstrapUe4(jar)
    return {
      jar,
      ue4SessionReady,
      getCookieHeader: (host: string) => jar.getCookieHeader(new URL(`https://${host}/`))
    }
  }

  private async requestExchangeCode(accessToken: string): Promise<string> {
    const response = await this.fetchImpl(EXCHANGE_ENDPOINT, {
      method: 'GET',
      headers: {
        Authorization: `bearer ${accessToken}`,
        'User-Agent': EPIC_USER_AGENT,
        Accept: 'application/json'
      }
    })
    if (!response.ok) {
      throw new EpicWebSessionError(
        'exchange-failed',
        `Epic /account/api/oauth/exchange returned ${response.status}`
      )
    }
    const body = (await response.json()) as { code?: string }
    if (!body.code) {
      throw new EpicWebSessionError(
        'exchange-failed',
        'Epic /account/api/oauth/exchange response missing "code" field'
      )
    }
    return body.code
  }

  private async bootstrapCsrf(jar: CookieJar): Promise<void> {
    const headers = {
      'User-Agent': BROWSER_UA,
      Referer: EPIC_LOGIN_REFERER,
      'X-Epic-Event-Action': 'login',
      'X-Epic-Event-Category': 'login',
      'X-Epic-Strategy-Flags': 'isolatedTestFlagEnabled=false',
      'X-Requested-With': 'XMLHttpRequest',
      Accept: 'application/json, text/plain, */*'
    }

    // First attempt: direct /id/api/csrf
    let response = await this.fetchImpl(CSRF_ENDPOINT, { method: 'GET', headers })
    jar.captureFromResponse(new URL(CSRF_ENDPOINT), response.headers)
    if (jar.getCookieValue(new URL(CSRF_ENDPOINT), 'XSRF-TOKEN')) return

    // Fallback: refresh-csrf then retry /id/api/csrf
    response = await this.fetchImpl(CSRF_REFRESH_ENDPOINT, { method: 'GET', headers })
    jar.captureFromResponse(new URL(CSRF_REFRESH_ENDPOINT), response.headers)
    response = await this.fetchImpl(CSRF_ENDPOINT, { method: 'GET', headers })
    jar.captureFromResponse(new URL(CSRF_ENDPOINT), response.headers)

    if (!jar.getCookieValue(new URL(CSRF_ENDPOINT), 'XSRF-TOKEN')) {
      throw new EpicWebSessionError(
        'csrf-missing',
        'Epic /id/api/csrf did not set XSRF-TOKEN even after refresh-csrf fallback'
      )
    }
  }

  private async fetchEpicSid(jar: CookieJar): Promise<string | null> {
    const url = new URL(EPIC_REDIRECT_ENDPOINT)
    try {
      const response = await this.fetchImpl(EPIC_REDIRECT_ENDPOINT, {
        method: 'GET',
        headers: {
          'User-Agent': LAUNCHER_UA,
          ...EPIC_WEB_HEADERS,
          'x-epic-duration': epicDurationHeader(),
          Accept: 'application/json, text/plain, */*',
          Cookie: jar.getCookieHeader(url)
        }
      })
      jar.captureFromResponse(url, response.headers)
      if (!response.ok) {
        console.warn(`[epic-web-session] E_V /id/api/redirect returned ${response.status}`)
        return null
      }
      const body = (await response.json()) as { sid?: string }
      const sid = typeof body.sid === 'string' && body.sid.length > 0 ? body.sid : null
      return sid
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.warn(`[epic-web-session] E_V /id/api/redirect threw: ${msg}`)
      return null
    }
  }

  private async setUeSid(jar: CookieJar, sid: string): Promise<void> {
    const url = new URL(`${UE_SET_SID_ENDPOINT}?sid=${encodeURIComponent(sid)}`)
    try {
      const response = await this.fetchImpl(url.toString(), {
        method: 'GET',
        headers: {
          'User-Agent': LAUNCHER_UA,
          ...EPIC_WEB_HEADERS,
          'x-epic-duration': epicDurationHeader(),
          Origin: 'https://www.epicgames.com',
          Cookie: jar.getCookieHeader(url)
        }
      })
      jar.captureFromResponse(url, response.headers)
      if (!response.ok && response.status !== 204) {
        console.warn(`[epic-web-session] E_H set-sid returned ${response.status}`)
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.warn(`[epic-web-session] E_H set-sid threw: ${msg}`)
    }
  }

  private async bootstrapUe4(jar: CookieJar): Promise<boolean> {
    const url = new URL(COSMOS_AUTH_ENDPOINT)
    try {
      const response = await this.fetchImpl(COSMOS_AUTH_ENDPOINT, {
        method: 'GET',
        headers: {
          'User-Agent': LAUNCHER_UA,
          ...EPIC_WEB_HEADERS,
          'x-epic-duration': epicDurationHeader(),
          Accept: 'application/json, text/plain, */*',
          Cookie: jar.getCookieHeader(url)
        }
      })
      jar.captureFromResponse(url, response.headers)
      if (!response.ok) {
        console.warn(
          `[epic-web-session] E4 cosmos/auth returned ${response.status} — continuing without UE.com session`
        )
        return false
      }
      return true
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.warn(`[epic-web-session] E4 cosmos/auth threw: ${msg} — continuing without UE.com session`)
      return false
    }
  }

  private async postExchange(jar: CookieJar, exchangeCode: string): Promise<void> {
    const url = new URL(EXCHANGE_POST_ENDPOINT)
    const xsrf = jar.getCookieValue(url, 'XSRF-TOKEN')
    if (!xsrf) {
      throw new EpicWebSessionError('csrf-missing', 'XSRF-TOKEN not in jar before E3 (programming error)')
    }
    const response = await this.fetchImpl(EXCHANGE_POST_ENDPOINT, {
      method: 'POST',
      headers: {
        'User-Agent': BROWSER_UA,
        'Content-Type': 'application/x-www-form-urlencoded',
        Referer: EPIC_LOGIN_REFERER,
        'X-XSRF-TOKEN': xsrf,
        'X-Requested-With': 'XMLHttpRequest',
        Accept: 'application/json, text/plain, */*',
        Cookie: jar.getCookieHeader(url)
      },
      body: `exchangeCode=${encodeURIComponent(exchangeCode)}`
    })
    if (!response.ok) {
      throw new EpicWebSessionError(
        'exchange-rejected',
        `Epic /id/api/exchange returned ${response.status}`
      )
    }
    jar.captureFromResponse(url, response.headers)
    if (!jar.getCookieValue(url, 'EPIC_SESSION_AP')) {
      throw new EpicWebSessionError(
        'no-epic-session',
        'Epic /id/api/exchange succeeded but did not set EPIC_SESSION_AP cookie'
      )
    }
  }
}
