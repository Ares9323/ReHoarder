import type { KvStore } from '../db/kv'
import type { Tokens } from './tokens'

/**
 * Abstract crypto interface so tests don't need an Electron runtime.
 * In production this is backed by `electron.safeStorage`.
 */
export interface CryptoBackend {
  isEncryptionAvailable(): boolean
  encryptString(value: string): Buffer
  decryptString(encrypted: Buffer): string
}

/** kv prefix for per-account token blobs: `auth.tokens.<accountId>`. */
const KEY_TOKENS_PREFIX = 'auth.tokens.'
/** kv prefix for the per-account "is the blob safeStorage-encrypted?" flag. */
const KEY_ENCRYPTED_PREFIX = 'auth.encrypted.'
/** Legacy single-account key from the pre-multi-account era. Migrated to its
 *  per-account slot on the first init. */
const LEGACY_KEY_TOKENS = 'auth.tokens'
const LEGACY_KEY_ENCRYPTED = 'auth.encrypted'

function tokensKey(accountId: string): string {
  return `${KEY_TOKENS_PREFIX}${accountId}`
}

function encryptedKey(accountId: string): string {
  return `${KEY_ENCRYPTED_PREFIX}${accountId}`
}

/**
 * Per-account encrypted token store. Each authenticated Epic account has its
 * own `auth.tokens.<accountId>` slot in the kv table, encrypted via
 * `safeStorage` when available. The active account is selected separately
 * via `AccountsRepo.setActiveId()` — this class only handles persistence.
 */
export class SecureTokenStorage {
  constructor(
    private readonly kv: KvStore,
    private readonly crypto: CryptoBackend
  ) {}

  save(tokens: Tokens): void {
    const json = JSON.stringify(tokens)
    const tKey = tokensKey(tokens.accountId)
    const eKey = encryptedKey(tokens.accountId)
    if (this.crypto.isEncryptionAvailable()) {
      const cipher = this.crypto.encryptString(json)
      this.kv.set(tKey, cipher.toString('base64'))
      this.kv.set(eKey, '1')
    } else {
      this.kv.set(tKey, json)
      this.kv.set(eKey, '0')
    }
  }

  load(accountId: string): Tokens | null {
    const raw = this.kv.get(tokensKey(accountId))
    if (raw === null) return null
    const flag = this.kv.get(encryptedKey(accountId))
    try {
      if (flag === '1') {
        const json = this.crypto.decryptString(Buffer.from(raw, 'base64'))
        return JSON.parse(json) as Tokens
      }
      return JSON.parse(raw) as Tokens
    } catch {
      return null
    }
  }

  clear(accountId: string): void {
    this.kv.delete(tokensKey(accountId))
    this.kv.delete(encryptedKey(accountId))
  }

  /** Every account id with a token blob currently persisted. */
  listAccountIds(): string[] {
    return this.kv
      .keys()
      .filter((k) => k.startsWith(KEY_TOKENS_PREFIX))
      .map((k) => k.slice(KEY_TOKENS_PREFIX.length))
  }

  /**
   * One-shot migration of the pre-multi-account `auth.tokens` slot to its
   * proper per-account slot. Reads the legacy blob (decrypting if needed),
   * extracts the embedded `accountId`, and persists it under
   * `auth.tokens.<accountId>` — then deletes the legacy keys. Idempotent:
   * if the legacy slot is empty (or unparseable) this is a no-op. Returns
   * the migrated account id (so the caller can also rebind the placeholder
   * `'legacy'` rows in the scoped tables), or `null` when nothing moved.
   */
  migrateLegacySlot(): string | null {
    const raw = this.kv.get(LEGACY_KEY_TOKENS)
    if (raw === null) return null
    const flag = this.kv.get(LEGACY_KEY_ENCRYPTED)
    let tokens: Tokens | null = null
    try {
      if (flag === '1') {
        const json = this.crypto.decryptString(Buffer.from(raw, 'base64'))
        tokens = JSON.parse(json) as Tokens
      } else {
        tokens = JSON.parse(raw) as Tokens
      }
    } catch {
      // Garbage on disk — drop it so we don't try again on next launch.
      this.kv.delete(LEGACY_KEY_TOKENS)
      this.kv.delete(LEGACY_KEY_ENCRYPTED)
      return null
    }
    if (!tokens || typeof tokens.accountId !== 'string' || tokens.accountId.length === 0) {
      this.kv.delete(LEGACY_KEY_TOKENS)
      this.kv.delete(LEGACY_KEY_ENCRYPTED)
      return null
    }
    // Re-save under the per-account slot, then drop the legacy keys. Going
    // through `save()` re-encrypts with the current safeStorage state, which
    // also handles the dev-env case where the legacy blob was plaintext.
    this.save(tokens)
    this.kv.delete(LEGACY_KEY_TOKENS)
    this.kv.delete(LEGACY_KEY_ENCRYPTED)
    return tokens.accountId
  }
}
