import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { KvStore } from '../db/kv'
import { SecureTokenStorage, type CryptoBackend } from './secure-storage'
import type { Tokens } from './tokens'

const fakeTokens: Tokens = {
  accessToken: 'a',
  refreshToken: 'r',
  accessExpiresAt: 1_000_000,
  refreshExpiresAt: 2_000_000,
  accountId: 'acct'
}

function makeKv(): KvStore {
  return new KvStore(new Database(':memory:'))
}

function makeEncryptingBackend(): CryptoBackend {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (s) => Buffer.from('ENC:' + s),
    decryptString: (b) => {
      const s = b.toString()
      if (!s.startsWith('ENC:')) throw new Error('not encrypted')
      return s.slice(4)
    }
  }
}

function makeUnavailableBackend(): CryptoBackend {
  return {
    isEncryptionAvailable: () => false,
    encryptString: () => {
      throw new Error('should not be called')
    },
    decryptString: () => {
      throw new Error('should not be called')
    }
  }
}

let kv: KvStore

beforeEach(() => {
  kv = makeKv()
})

describe('SecureTokenStorage — encryption available', () => {
  it('saves tokens encrypted (ciphertext on disk, not plaintext)', () => {
    const storage = new SecureTokenStorage(kv, makeEncryptingBackend())
    storage.save(fakeTokens)
    const raw = kv.get(`auth.tokens.${fakeTokens.accountId}`)
    expect(raw).not.toBeNull()
    expect(raw).not.toContain('"accessToken":"a"')
  })

  it('round-trips tokens through encrypted save+load', () => {
    const storage = new SecureTokenStorage(kv, makeEncryptingBackend())
    storage.save(fakeTokens)
    expect(storage.load(fakeTokens.accountId)).toEqual(fakeTokens)
  })

  it('records that the on-disk blob is encrypted', () => {
    const storage = new SecureTokenStorage(kv, makeEncryptingBackend())
    storage.save(fakeTokens)
    expect(kv.get(`auth.encrypted.${fakeTokens.accountId}`)).toBe('1')
  })

  it('returns null when no tokens are saved', () => {
    const storage = new SecureTokenStorage(kv, makeEncryptingBackend())
    expect(storage.load(fakeTokens.accountId)).toBeNull()
  })

  it('clears tokens', () => {
    const storage = new SecureTokenStorage(kv, makeEncryptingBackend())
    storage.save(fakeTokens)
    storage.clear(fakeTokens.accountId)
    expect(storage.load(fakeTokens.accountId)).toBeNull()
    expect(kv.get(`auth.tokens.${fakeTokens.accountId}`)).toBeNull()
    expect(kv.get(`auth.encrypted.${fakeTokens.accountId}`)).toBeNull()
  })

  it('lists every account id that has a token blob', () => {
    const storage = new SecureTokenStorage(kv, makeEncryptingBackend())
    storage.save(fakeTokens)
    storage.save({ ...fakeTokens, accountId: 'other' })
    expect(storage.listAccountIds().sort()).toEqual(['acct', 'other'])
  })
})

describe('SecureTokenStorage — encryption unavailable (fallback)', () => {
  it('falls back to plain JSON when encryption is unavailable', () => {
    const storage = new SecureTokenStorage(kv, makeUnavailableBackend())
    storage.save(fakeTokens)
    const raw = kv.get(`auth.tokens.${fakeTokens.accountId}`)
    expect(raw).toContain('"accessToken":"a"')
  })

  it('round-trips tokens through plain JSON save+load', () => {
    const storage = new SecureTokenStorage(kv, makeUnavailableBackend())
    storage.save(fakeTokens)
    expect(storage.load(fakeTokens.accountId)).toEqual(fakeTokens)
  })

  it('records that the on-disk blob is NOT encrypted', () => {
    const storage = new SecureTokenStorage(kv, makeUnavailableBackend())
    storage.save(fakeTokens)
    expect(kv.get(`auth.encrypted.${fakeTokens.accountId}`)).toBe('0')
  })
})

describe('SecureTokenStorage — backend changes between save and load', () => {
  it('reads back an encrypted blob even if encryption becomes "unavailable" later (defensive)', () => {
    const encryptingBackend = makeEncryptingBackend()
    new SecureTokenStorage(kv, encryptingBackend).save(fakeTokens)

    const stillCapable: CryptoBackend = {
      ...encryptingBackend,
      isEncryptionAvailable: () => false
    }
    const storage = new SecureTokenStorage(kv, stillCapable)
    expect(storage.load(fakeTokens.accountId)).toEqual(fakeTokens)
  })

  it('returns null when an encrypted blob exists but decryption fails', () => {
    new SecureTokenStorage(kv, makeEncryptingBackend()).save(fakeTokens)
    const brokenBackend: CryptoBackend = {
      isEncryptionAvailable: () => true,
      encryptString: () => {
        throw new Error('nope')
      },
      decryptString: () => {
        throw new Error('decryption failed')
      }
    }
    const storage = new SecureTokenStorage(kv, brokenBackend)
    expect(storage.load(fakeTokens.accountId)).toBeNull()
  })
})

describe('SecureTokenStorage.migrateLegacySlot', () => {
  it('moves a legacy `auth.tokens` blob into the per-account slot', () => {
    const backend = makeUnavailableBackend()
    // Stamp the legacy kv keys directly (no API for that any more).
    kv.set('auth.tokens', JSON.stringify(fakeTokens))
    kv.set('auth.encrypted', '0')
    const storage = new SecureTokenStorage(kv, backend)
    const id = storage.migrateLegacySlot()
    expect(id).toBe('acct')
    expect(kv.get('auth.tokens')).toBeNull()
    expect(kv.get(`auth.tokens.${fakeTokens.accountId}`)).not.toBeNull()
    expect(storage.load(fakeTokens.accountId)).toEqual(fakeTokens)
  })

  it('is a no-op when no legacy blob exists', () => {
    const storage = new SecureTokenStorage(kv, makeUnavailableBackend())
    expect(storage.migrateLegacySlot()).toBeNull()
  })

  it('drops the legacy blob when it cannot be decrypted', () => {
    kv.set('auth.tokens', 'garbage')
    kv.set('auth.encrypted', '0')
    const storage = new SecureTokenStorage(kv, makeUnavailableBackend())
    expect(storage.migrateLegacySlot()).toBeNull()
    expect(kv.get('auth.tokens')).toBeNull()
  })
})
