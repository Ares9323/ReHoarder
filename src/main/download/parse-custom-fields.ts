import type { BinaryReader } from './binary-reader'

export function parseCustomFields(r: BinaryReader): Record<string, string> {
  const start = r.position
  const sectionSize = r.readUInt32LE()
  r.readUInt8() // version
  const count = r.readInt32LE()
  const keys: string[] = []
  for (let i = 0; i < count; i++) keys.push(r.readFString())
  const values: string[] = []
  for (let i = 0; i < count; i++) values.push(r.readFString())
  r.seek(start + sectionSize)
  const out: Record<string, string> = {}
  for (let i = 0; i < count; i++) out[keys[i]] = values[i]
  return out
}
