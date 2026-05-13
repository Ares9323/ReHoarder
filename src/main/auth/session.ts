import { EventEmitter } from 'node:events'
import { OAuthClient, OAuthError } from './oauth-client'
import type { SecureTokenStorage } from './secure-storage'
import {
  tokensFromOAuthResponse,
  isAccessTokenExpired,
  isRefreshTokenExpired,
  type Tokens
} from './tokens'

export type AuthState =
  | { status: 'anonymous' }
  | { status: 'authenticated'; accountId: string; displayName: string }

export class Session extends EventEmitter {
  private state: AuthState = { status: 'anonymous' }
  private currentTokens: Tokens | null = null

  constructor(
    private readonly storage: SecureTokenStorage,
    private readonly client: OAuthClient
  ) {
    super()
  }

  getState(): AuthState {
    return this.state
  }

  getAccessToken(): string | null {
    return this.currentTokens?.accessToken ?? null
  }

  async init(): Promise<void> {
    let tokens = this.storage.load()
    if (tokens === null) {
      console.warn('[auth] init: no tokens on disk')
      this.currentTokens = null
      this.setState({ status: 'anonymous' })
      return
    }

    if (isRefreshTokenExpired(tokens)) {
      console.warn('[auth] init: refresh token expired, clearing')
      this.storage.clear()
      this.currentTokens = null
      this.setState({ status: 'anonymous' })
      return
    }

    if (isAccessTokenExpired(tokens)) {
      console.warn('[auth] init: access token expired, refreshing')
      try {
        tokens = await this.doRefresh(tokens.refreshToken)
      } catch (err) {
        console.warn(`[auth] init: refresh failed: ${err instanceof Error ? err.message : err}`)
        this.storage.clear()
        this.currentTokens = null
        this.setState({ status: 'anonymous' })
        return
      }
    }

    try {
      await this.verifyAndPublish(tokens)
      this.currentTokens = tokens
      console.warn('[auth] init: verified, authenticated')
    } catch (err) {
      console.warn(`[auth] init: verify failed: ${err instanceof Error ? err.message : err}`)
      this.storage.clear()
      this.currentTokens = null
      this.setState({ status: 'anonymous' })
    }
  }

  async exchangeCode(code: string): Promise<void> {
    const response = await this.client.exchangeCode(code)
    const tokens = tokensFromOAuthResponse(response)
    this.storage.save(tokens)
    this.currentTokens = tokens
    await this.verifyAndPublish(tokens)
  }

  async logout(): Promise<void> {
    this.storage.clear()
    this.currentTokens = null
    this.setState({ status: 'anonymous' })
  }

  private async doRefresh(refreshToken: string): Promise<Tokens> {
    const response = await this.client.refresh(refreshToken)
    const tokens = tokensFromOAuthResponse(response)
    this.storage.save(tokens)
    this.currentTokens = tokens
    return tokens
  }

  private async verifyAndPublish(tokens: Tokens): Promise<void> {
    const profile = await this.client.verify(tokens.accessToken)
    this.setState({
      status: 'authenticated',
      accountId: profile.account_id,
      displayName: profile.display_name
    })
  }

  private setState(next: AuthState): void {
    this.state = next
    this.emit('state-changed', next)
  }
}

export { OAuthError }
