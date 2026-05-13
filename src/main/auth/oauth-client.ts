import {
  EPIC_LAUNCHER_BASIC_AUTH,
  EPIC_TOKEN_ENDPOINT,
  EPIC_VERIFY_ENDPOINT
} from './epic-credentials'
import type { OAuthTokenResponse } from './tokens'

export interface VerifyResponse {
  account_id: string
  display_name: string
  token_type: string
}

/** Error thrown for any non-2xx response from Epic. */
export class OAuthError extends Error {
  readonly status: number
  readonly errorCode?: string
  readonly errorMessage?: string

  constructor(status: number, body: { errorCode?: string; errorMessage?: string } | string) {
    const errorCode = typeof body === 'object' ? body.errorCode : undefined
    const errorMessage = typeof body === 'object' ? body.errorMessage : undefined
    super(`Epic OAuth error ${status}${errorCode ? ` (${errorCode})` : ''}`)
    this.name = 'OAuthError'
    this.status = status
    this.errorCode = errorCode
    this.errorMessage = errorMessage
  }
}

export class OAuthClient {
  constructor(private readonly fetchImpl: typeof fetch = globalThis.fetch) {}

  async exchangeCode(code: string): Promise<OAuthTokenResponse> {
    return this.tokenRequest({
      grant_type: 'authorization_code',
      code: code.trim(),
      token_type: 'eg1'
    })
  }

  async refresh(refreshToken: string): Promise<OAuthTokenResponse> {
    return this.tokenRequest({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      token_type: 'eg1'
    })
  }

  async verify(accessToken: string): Promise<VerifyResponse> {
    const response = await this.fetchImpl(EPIC_VERIFY_ENDPOINT, {
      method: 'GET',
      headers: {
        Authorization: `bearer ${accessToken}`,
        Accept: 'application/json'
      }
    })

    const parsed = await this.parseBody(response)
    if (!response.ok) throw new OAuthError(response.status, parsed as never)
    return parsed as VerifyResponse
  }

  private async tokenRequest(form: Record<string, string>): Promise<OAuthTokenResponse> {
    const body = new URLSearchParams(form).toString()
    const response = await this.fetchImpl(EPIC_TOKEN_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: EPIC_LAUNCHER_BASIC_AUTH,
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json'
      },
      body
    })

    const parsed = await this.parseBody(response)
    if (!response.ok) throw new OAuthError(response.status, parsed as never)
    return parsed as OAuthTokenResponse
  }

  private async parseBody(response: Response): Promise<unknown> {
    const text = await response.text()
    if (!text) return null
    try {
      return JSON.parse(text)
    } catch {
      return text
    }
  }
}
