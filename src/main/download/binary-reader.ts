/**
 * Forward-only reader over a binary Buffer. Tracks current position;
 * each `readXxx()` advances. Used to parse Epic Chunked Manifest sections.
 *
 * Throws if a read would go past end-of-buffer.
 */
export class BinaryReader {
  private pos = 0

  constructor(private readonly buf: Buffer) {}

  get position(): number {
    return this.pos
  }

  get size(): number {
    return this.buf.length
  }

  seek(absolutePos: number): void {
    if (absolutePos < 0 || absolutePos > this.buf.length) {
      throw new Error(
        `BinaryReader: seek to ${absolutePos} out of range [0, ${this.buf.length}]`
      )
    }
    this.pos = absolutePos
  }

  private require(n: number): void {
    if (this.pos + n > this.buf.length) {
      throw new Error(
        `BinaryReader: read of ${n} bytes at pos=${this.pos} exceeds buffer size ${this.buf.length}`
      )
    }
  }

  readUInt8(): number {
    this.require(1)
    const v = this.buf.readUInt8(this.pos)
    this.pos += 1
    return v
  }

  readInt8(): number {
    this.require(1)
    const v = this.buf.readInt8(this.pos)
    this.pos += 1
    return v
  }

  readUInt16LE(): number {
    this.require(2)
    const v = this.buf.readUInt16LE(this.pos)
    this.pos += 2
    return v
  }

  readInt32LE(): number {
    this.require(4)
    const v = this.buf.readInt32LE(this.pos)
    this.pos += 4
    return v
  }

  readUInt32LE(): number {
    this.require(4)
    const v = this.buf.readUInt32LE(this.pos)
    this.pos += 4
    return v
  }

  readUInt64LE(): bigint {
    this.require(8)
    const v = this.buf.readBigUInt64LE(this.pos)
    this.pos += 8
    return v
  }

  readInt64LE(): bigint {
    this.require(8)
    const v = this.buf.readBigInt64LE(this.pos)
    this.pos += 8
    return v
  }

  /**
   * Read an Unreal `FGuid` (16 bytes = 4 × uint32 LE) and return its
   * canonical 32-char uppercase hex form. The four uint32s are emitted in
   * declaration order; this matches how Unreal serializes `FGuid` and how
   * Epic manifests reference chunks (e.g. `ChunkHashList` keys, the file
   * portion of a chunk URL, the GUID field in `FChunkPart`).
   *
   * Do NOT use `readBytes(16).toString('hex')` for GUIDs — that yields the
   * raw byte order, which reverses each uint32 vs. the canonical form.
   */
  readFGuid(): string {
    const a = this.readUInt32LE()
    const b = this.readUInt32LE()
    const c = this.readUInt32LE()
    const d = this.readUInt32LE()
    return (
      a.toString(16).toUpperCase().padStart(8, '0') +
      b.toString(16).toUpperCase().padStart(8, '0') +
      c.toString(16).toUpperCase().padStart(8, '0') +
      d.toString(16).toUpperCase().padStart(8, '0')
    )
  }

  readBytes(n: number): Buffer {
    this.require(n)
    const slice = Buffer.alloc(n)
    this.buf.copy(slice, 0, this.pos, this.pos + n)
    this.pos += n
    return slice
  }

  /**
   * Reads an Unreal FString:
   *   int32 length
   *   if length == 0: empty string
   *   if length  > 0: UTF-8, `length` bytes total, last byte is null terminator
   *   if length  < 0: UTF-16LE, `-length` uint16 units total, last unit is null terminator
   */
  readFString(): string {
    const len = this.readInt32LE()
    if (len === 0) return ''
    if (len > 0) {
      const bytes = this.readBytes(len)
      // Strip the trailing null byte (always present in a valid FString; assumed if missing).
      const end = bytes.length > 0 ? bytes.length - 1 : 0
      return bytes.toString('utf8', 0, end)
    }
    const units = -len
    const bytes = this.readBytes(units * 2)
    // Strip the trailing null uint16 if present.
    let end = bytes.length
    if (end >= 2 && bytes[end - 2] === 0 && bytes[end - 1] === 0) {
      end -= 2
    }
    return bytes.toString('utf16le', 0, end)
  }
}
