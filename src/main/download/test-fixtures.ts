/**
 * Test-only byte-stream builders. Produce the same wire format the parsers
 * consume, so each parser test can author its input alongside the expected
 * output, no external fixtures required.
 *
 * NOT for production use — never imported from `src/main/*` outside of `*.test.ts`.
 */

export function uint8(n: number): Buffer {
  const b = Buffer.alloc(1)
  b.writeUInt8(n, 0)
  return b
}

export function int8(n: number): Buffer {
  const b = Buffer.alloc(1)
  b.writeInt8(n, 0)
  return b
}

export function uint16le(n: number): Buffer {
  const b = Buffer.alloc(2)
  b.writeUInt16LE(n, 0)
  return b
}

export function uint32le(n: number): Buffer {
  const b = Buffer.alloc(4)
  b.writeUInt32LE(n, 0)
  return b
}

export function int32le(n: number): Buffer {
  const b = Buffer.alloc(4)
  b.writeInt32LE(n, 0)
  return b
}

export function uint64le(n: bigint): Buffer {
  const b = Buffer.alloc(8)
  b.writeBigUInt64LE(n, 0)
  return b
}

export function int64le(n: bigint): Buffer {
  const b = Buffer.alloc(8)
  b.writeBigInt64LE(n, 0)
  return b
}

/** Builds an Epic FString as bytes (UTF-8, with trailing null). */
export function fstring(s: string): Buffer {
  if (s.length === 0) return int32le(0)
  const body = Buffer.concat([Buffer.from(s, 'utf8'), Buffer.from([0])])
  return Buffer.concat([int32le(body.length), body])
}

/** Builds an Epic FString as UTF-16LE (negative length). */
export function fstringUtf16(s: string): Buffer {
  const body = Buffer.concat([Buffer.from(s, 'utf16le'), Buffer.from([0, 0])])
  // unitCount = body.length / 2, length field = -(unitCount)
  const units = body.length / 2
  return Buffer.concat([int32le(-units), body])
}

/** 20-byte SHA1 placeholder buffer. Caller supplies hex (40 chars). */
export function sha1Hex(hex40: string): Buffer {
  if (hex40.length !== 40) throw new Error(`sha1Hex needs 40 chars, got ${hex40.length}`)
  return Buffer.from(hex40, 'hex')
}

/** 16-byte FGuid as four uint32 LE. `hex32` is 32 hex chars. */
export function guidHex(hex32: string): Buffer {
  if (hex32.length !== 32) throw new Error(`guidHex needs 32 chars, got ${hex32.length}`)
  // Epic FGuid is serialized as 4 × uint32 LE. To convert the canonical
  // 32-char hex (4 uint32s in declaration order) into the on-wire byte
  // sequence, reverse each 4-byte group: the parser side reads with
  // `readFGuid()` which undoes this.
  const raw = Buffer.from(hex32, 'hex')
  const out = Buffer.alloc(16)
  for (let i = 0; i < 16; i += 4) {
    out[i] = raw[i + 3]
    out[i + 1] = raw[i + 2]
    out[i + 2] = raw[i + 1]
    out[i + 3] = raw[i]
  }
  return out
}

/** Concatenate any number of byte chunks. */
export function bytes(...parts: Buffer[]): Buffer {
  return Buffer.concat(parts)
}
