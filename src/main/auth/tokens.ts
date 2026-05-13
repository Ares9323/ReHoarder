/**
 * In-memory representation of the Epic OAuth tokens this app holds.
 * Times are absolute Unix-ms timestamps so we don't need to know when
 * the response was received to decide if a token is still valid.
 */
export interface Tokens {
  accessToken: string
  refreshToken: string
  accessExpiresAt: number
  refreshExpiresAt: number
  accountId: string
}

/**
 * Shape of a successful response from `POST /account/api/oauth/token`.
 * Only the fields we use are typed — Epic returns more.
 *
 * IMPORTANT: the refresh token validity field is named `refresh_expires`
 * (in seconds), NOT `refresh_expires_in`. The access-token field IS named
 * `expires_in`. This naming asymmetry is Epic's, not ours — confirmed
 * against the Legendary/Heroic source code which has been talking to this
 * API for years.
 */
export interface OAuthTokenResponse {
  access_token: string
  refresh_token: string
  expires_in: number
  refresh_expires: number
  account_id: string
}

export function tokensFromOAuthResponse(r: OAuthTokenResponse, now: number = Date.now()): Tokens {
  return {
    accessToken: r.access_token,
    refreshToken: r.refresh_token,
    accessExpiresAt: now + r.expires_in * 1000,
    refreshExpiresAt: now + r.refresh_expires * 1000,
    accountId: r.account_id
  }
}

const SAFETY_WINDOW_MS = 60_000

export function isAccessTokenExpired(tokens: Tokens, now: number = Date.now()): boolean {
  return tokens.accessExpiresAt - SAFETY_WINDOW_MS <= now
}

export function isRefreshTokenExpired(tokens: Tokens, now: number = Date.now()): boolean {
  return tokens.refreshExpiresAt <= now
}
