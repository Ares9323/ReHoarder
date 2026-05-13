import { describe, it, expect, vi, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { KvStore } from '../db/kv'
import { SecureTokenStorage, type CryptoBackend } from './secure-storage'
import { OAuthClient } from './oauth-client'
import { Session, type AuthState } from './session'

const passthroughCrypto: CryptoBackend = {
  isEncryptionAvailable: () => false,
  encryptString: () => {
    throw new Error('not used')
  },
  decryptString: () => {
    throw new Error('not used')
  }
}

function tokenResponseFixture(
  over: Partial<Record<string, unknown>> = {}
): Record<string, unknown> {
  return {
    access_token: 'a',
    refresh_token: 'r',
    expires_in: 7200,
    refresh_expires: 2_592_000,
    account_id: 'acct',
    ...over
  }
}

function verifyResponseFixture(
  over: Partial<Record<string, unknown>> = {}
): Record<string, unknown> {
  return {
    account_id: 'acct',
    display_name: 'TestUser',
    token_type: 'bearer',
    ...over
  }
}

function makeJsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  })
}

let kv: KvStore
let storage: SecureTokenStorage
let fetchMock: ReturnType<typeof vi.fn>
let client: OAuthClient
let session: Session
let stateChanges: AuthState[]

beforeEach(() => {
  kv = new KvStore(new Database(':memory:'))
  storage = new SecureTokenStorage(kv, passthroughCrypto)
  fetchMock = vi.fn()
  client = new OAuthClient(fetchMock as unknown as typeof fetch)
  session = new Session(storage, client)
  stateChanges = []
  session.on('state-changed', (s) => stateChanges.push(s))
})

describe('Session.init', () => {
  it('lands on anonymous when no tokens are saved', async () => {
    await session.init()
    expect(session.getState()).toEqual<AuthState>({ status: 'anonymous' })
  })

  it('lands on authenticated when saved tokens are still valid (after verify)', async () => {
    storage.save({
      accessToken: 'a',
      refreshToken: 'r',
      accessExpiresAt: Date.now() + 3_600_000,
      refreshExpiresAt: Date.now() + 30 * 86_400_000,
      accountId: 'acct'
    })
    fetchMock.mockImplementation(() =>
      Promise.resolve(makeJsonResponse(verifyResponseFixture({ display_name: 'Ares' })))
    )

    await session.init()

    expect(session.getState()).toEqual<AuthState>({
      status: 'authenticated',
      accountId: 'acct',
      displayName: 'Ares'
    })
  })

  it('refreshes when access token is expired but refresh token is valid', async () => {
    storage.save({
      accessToken: 'old',
      refreshToken: 'r-old',
      accessExpiresAt: Date.now() - 1,
      refreshExpiresAt: Date.now() + 30 * 86_400_000,
      accountId: 'acct'
    })

    fetchMock
      .mockImplementationOnce(() =>
        Promise.resolve(
          makeJsonResponse(tokenResponseFixture({ access_token: 'a2', refresh_token: 'r2' }))
        )
      )
      .mockImplementationOnce(() =>
        Promise.resolve(makeJsonResponse(verifyResponseFixture({ display_name: 'Ares' })))
      )

    await session.init()

    expect(session.getState()).toMatchObject({
      status: 'authenticated',
      displayName: 'Ares'
    })
    const persisted = storage.load()
    expect(persisted?.accessToken).toBe('a2')
    expect(persisted?.refreshToken).toBe('r2')
  })

  it('clears tokens and goes anonymous when refresh fails', async () => {
    storage.save({
      accessToken: 'old',
      refreshToken: 'dead',
      accessExpiresAt: Date.now() - 1,
      refreshExpiresAt: Date.now() + 30 * 86_400_000,
      accountId: 'acct'
    })
    fetchMock.mockImplementationOnce(() =>
      Promise.resolve(makeJsonResponse({ errorCode: 'invalid_refresh_token' }, 400))
    )

    await session.init()

    expect(session.getState()).toEqual<AuthState>({ status: 'anonymous' })
    expect(storage.load()).toBeNull()
  })

  it('goes anonymous when refresh token itself has expired (no network call needed)', async () => {
    storage.save({
      accessToken: 'old',
      refreshToken: 'r',
      accessExpiresAt: Date.now() - 1,
      refreshExpiresAt: Date.now() - 1,
      accountId: 'acct'
    })

    await session.init()

    expect(session.getState()).toEqual<AuthState>({ status: 'anonymous' })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(storage.load()).toBeNull()
  })
})

describe('Session.exchangeCode', () => {
  it('saves tokens, calls verify, lands on authenticated', async () => {
    fetchMock
      .mockImplementationOnce(() => Promise.resolve(makeJsonResponse(tokenResponseFixture())))
      .mockImplementationOnce(() =>
        Promise.resolve(makeJsonResponse(verifyResponseFixture({ display_name: 'Ares' })))
      )

    await session.exchangeCode('the-code')

    expect(session.getState()).toEqual<AuthState>({
      status: 'authenticated',
      accountId: 'acct',
      displayName: 'Ares'
    })
    expect(storage.load()).not.toBeNull()
  })

  it('throws on bad code, leaves state anonymous, leaves storage empty', async () => {
    fetchMock.mockImplementationOnce(() =>
      Promise.resolve(makeJsonResponse({ errorCode: 'exchange_code_not_found' }, 400))
    )

    await expect(session.exchangeCode('bad')).rejects.toThrow()
    expect(session.getState()).toEqual<AuthState>({ status: 'anonymous' })
    expect(storage.load()).toBeNull()
  })

  it('emits state-changed when transitioning to authenticated', async () => {
    fetchMock
      .mockImplementationOnce(() => Promise.resolve(makeJsonResponse(tokenResponseFixture())))
      .mockImplementationOnce(() =>
        Promise.resolve(makeJsonResponse(verifyResponseFixture({ display_name: 'Ares' })))
      )

    await session.exchangeCode('the-code')

    expect(stateChanges.at(-1)).toMatchObject({ status: 'authenticated' })
  })
})

describe('Session.getAccessToken', () => {
  it('returns null when anonymous', () => {
    expect(session.getAccessToken()).toBeNull()
  })

  it('returns the current access token when authenticated', async () => {
    fetchMock
      .mockImplementationOnce(() => Promise.resolve(makeJsonResponse(tokenResponseFixture())))
      .mockImplementationOnce(() =>
        Promise.resolve(makeJsonResponse(verifyResponseFixture({ display_name: 'Ares' })))
      )
    await session.exchangeCode('the-code')
    expect(session.getAccessToken()).toBe('a')
  })
})

describe('Session.logout', () => {
  it('clears tokens and emits anonymous state', async () => {
    storage.save({
      accessToken: 'a',
      refreshToken: 'r',
      accessExpiresAt: Date.now() + 3_600_000,
      refreshExpiresAt: Date.now() + 30 * 86_400_000,
      accountId: 'acct'
    })
    fetchMock.mockImplementation(() => Promise.resolve(makeJsonResponse(verifyResponseFixture())))
    await session.init()
    stateChanges.length = 0

    await session.logout()

    expect(session.getState()).toEqual<AuthState>({ status: 'anonymous' })
    expect(storage.load()).toBeNull()
    expect(stateChanges.at(-1)).toEqual<AuthState>({ status: 'anonymous' })
  })
})
