import { describe, it, expect, vi } from 'vitest'
import { tokensFromOAuthResponse, isAccessTokenExpired, type Tokens } from './tokens'

describe('tokensFromOAuthResponse', () => {
  it('maps Epic OAuth response into a Tokens object with absolute expiry timestamps', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-05-12T12:00:00Z'))

    const response = {
      access_token: 'a-token',
      refresh_token: 'r-token',
      expires_in: 7200,
      refresh_expires: 2_592_000,
      account_id: 'acct-1',
      token_type: 'bearer'
    }

    const tokens = tokensFromOAuthResponse(response)
    expect(tokens).toEqual<Tokens>({
      accessToken: 'a-token',
      refreshToken: 'r-token',
      accessExpiresAt: new Date('2026-05-12T14:00:00Z').getTime(),
      refreshExpiresAt: new Date('2026-06-11T12:00:00Z').getTime(),
      accountId: 'acct-1'
    })

    vi.useRealTimers()
  })
})

describe('isAccessTokenExpired', () => {
  it('returns false when expiry is comfortably in the future', () => {
    const now = Date.now()
    expect(isAccessTokenExpired({ accessExpiresAt: now + 3600_000 } as Tokens, now)).toBe(false)
  })

  it('returns true when expiry has passed', () => {
    const now = Date.now()
    expect(isAccessTokenExpired({ accessExpiresAt: now - 1 } as Tokens, now)).toBe(true)
  })

  it('returns true within the 60s safety window before actual expiry', () => {
    const now = Date.now()
    expect(isAccessTokenExpired({ accessExpiresAt: now + 30_000 } as Tokens, now)).toBe(true)
  })
})
