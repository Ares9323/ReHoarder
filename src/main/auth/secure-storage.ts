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

const KEY_TOKENS = 'auth.tokens'
const KEY_ENCRYPTED_FLAG = 'auth.encrypted'

export class SecureTokenStorage {
  constructor(
    private readonly kv: KvStore,
    private readonly crypto: CryptoBackend
  ) {}

  save(tokens: Tokens): void {
    const json = JSON.stringify(tokens)
    if (this.crypto.isEncryptionAvailable()) {
      const cipher = this.crypto.encryptString(json)
      this.kv.set(KEY_TOKENS, cipher.toString('base64'))
      this.kv.set(KEY_ENCRYPTED_FLAG, '1')
    } else {
      this.kv.set(KEY_TOKENS, json)
      this.kv.set(KEY_ENCRYPTED_FLAG, '0')
    }
  }

  load(): Tokens | null {
    const raw = this.kv.get(KEY_TOKENS)
    if (raw === null) return null

    const flag = this.kv.get(KEY_ENCRYPTED_FLAG)
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

  clear(): void {
    this.kv.delete(KEY_TOKENS)
    this.kv.delete(KEY_ENCRYPTED_FLAG)
  }
}
