import { describe, it, expect, vi, beforeEach } from 'vitest'
import { OAuthClient, OAuthError } from './oauth-client'
import { EPIC_TOKEN_ENDPOINT, EPIC_LAUNCHER_BASIC_AUTH } from './epic-credentials'

let fetchMock: ReturnType<typeof vi.fn>
let client: OAuthClient

beforeEach(() => {
  fetchMock = vi.fn()
  client = new OAuthClient(fetchMock as unknown as typeof fetch)
})

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  })
}

describe('OAuthClient.exchangeCode', () => {
  it('POSTs to the token endpoint with the Launcher basic auth header', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        access_token: 'a',
        refresh_token: 'r',
        expires_in: 7200,
        refresh_expires: 2_592_000,
        account_id: 'acct'
      })
    )

    await client.exchangeCode('the-code')

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe(EPIC_TOKEN_ENDPOINT)
    expect(init.method).toBe('POST')
    expect(init.headers['Authorization']).toBe(EPIC_LAUNCHER_BASIC_AUTH)
    expect(init.headers['Content-Type']).toBe('application/x-www-form-urlencoded')
  })

  it('sends grant_type=authorization_code with the code and token_type=eg1', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        access_token: 'a',
        refresh_token: 'r',
        expires_in: 7200,
        refresh_expires: 2_592_000,
        account_id: 'acct'
      })
    )

    await client.exchangeCode('the-code')

    const init = fetchMock.mock.calls[0][1]
    const body = init.body as string
    const params = new URLSearchParams(body)
    expect(params.get('grant_type')).toBe('authorization_code')
    expect(params.get('code')).toBe('the-code')
    expect(params.get('token_type')).toBe('eg1')
  })

  it('returns the parsed token response on 200', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        access_token: 'a',
        refresh_token: 'r',
        expires_in: 7200,
        refresh_expires: 2_592_000,
        account_id: 'acct'
      })
    )

    const result = await client.exchangeCode('the-code')
    expect(result.access_token).toBe('a')
    expect(result.refresh_token).toBe('r')
    expect(result.account_id).toBe('acct')
  })

  it('throws OAuthError with Epic error fields on 400', async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(
        jsonResponse(
          { errorCode: 'errors.com.epicgames.account.oauth.exchange_code_not_found' },
          400
        )
      )
    )

    await expect(client.exchangeCode('bad-code')).rejects.toBeInstanceOf(OAuthError)
    await expect(client.exchangeCode('bad-code')).rejects.toMatchObject({
      status: 400,
      errorCode: 'errors.com.epicgames.account.oauth.exchange_code_not_found'
    })
  })

  it('trims whitespace from the code (users paste with newlines)', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        access_token: 'a',
        refresh_token: 'r',
        expires_in: 7200,
        refresh_expires: 2_592_000,
        account_id: 'acct'
      })
    )

    await client.exchangeCode('  the-code\n  ')

    const init = fetchMock.mock.calls[0][1]
    const params = new URLSearchParams(init.body as string)
    expect(params.get('code')).toBe('the-code')
  })
})

describe('OAuthClient.refresh', () => {
  it('POSTs grant_type=refresh_token with the refresh token and token_type=eg1', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        access_token: 'a2',
        refresh_token: 'r2',
        expires_in: 7200,
        refresh_expires: 2_592_000,
        account_id: 'acct'
      })
    )

    await client.refresh('old-refresh')

    const init = fetchMock.mock.calls[0][1]
    const params = new URLSearchParams(init.body as string)
    expect(params.get('grant_type')).toBe('refresh_token')
    expect(params.get('refresh_token')).toBe('old-refresh')
    expect(params.get('token_type')).toBe('eg1')
  })

  it('returns the new token pair on 200', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        access_token: 'a2',
        refresh_token: 'r2',
        expires_in: 7200,
        refresh_expires: 2_592_000,
        account_id: 'acct'
      })
    )

    const result = await client.refresh('old-refresh')
    expect(result.access_token).toBe('a2')
    expect(result.refresh_token).toBe('r2')
  })

  it('throws OAuthError when the refresh token is expired', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        { errorCode: 'errors.com.epicgames.account.auth_token.invalid_refresh_token' },
        400
      )
    )

    await expect(client.refresh('dead')).rejects.toBeInstanceOf(OAuthError)
  })
})

describe('OAuthClient.verify', () => {
  it('GETs the verify endpoint with the bearer access token', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        account_id: 'acct-1',
        display_name: 'TestUser',
        token_type: 'bearer'
      })
    )

    await client.verify('a-token')

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe(
      'https://account-public-service-prod.ol.epicgames.com/account/api/oauth/verify'
    )
    expect(init.method).toBe('GET')
    expect(init.headers['Authorization']).toBe('bearer a-token')
  })

  it('returns the parsed verify response', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        account_id: 'acct-1',
        display_name: 'TestUser',
        token_type: 'bearer'
      })
    )

    const result = await client.verify('a-token')
    expect(result.account_id).toBe('acct-1')
    expect(result.display_name).toBe('TestUser')
  })

  it('throws OAuthError on 401 (invalid/expired access token)', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ errorCode: 'invalid_token' }, 401))

    await expect(client.verify('dead-token')).rejects.toMatchObject({
      status: 401
    })
  })
})
