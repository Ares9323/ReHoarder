import * as crypto from 'node:crypto'

/**
 * Direct TypeScript port of UnrealPluginToggler's IniPatchService. The merge
 * semantics are intentionally identical so a master file authored against the
 * existing tool keeps working here verbatim — only the directive prefix and
 * the sentinel branding switch from `@Ares:` / `UnrealPluginToggler` to
 * `@ReHoarder:` / `ReHoarder`.
 *
 * High-level: parse the engine's Base*.ini and the user's master into IniDocs,
 * `applyMerge` mutates the engine doc in place, serialize back. The sentinel
 * header in the output tells future runs that the file was already patched
 * (and which master hash it was patched against) so we can detect drift.
 */

export type IniLineKind =
  | 'blank'
  | 'comment'
  | 'directive'
  | 'sectionHeader'
  | 'scalar'
  | 'arrayAdd'

export type PatchDirective = 'none' | 'commentAll' | 'appendArray'

export interface IniLine {
  /** Original raw text (preserved verbatim for serialization). */
  raw: string
  kind: IniLineKind
  key?: string
  value?: string
  /** Trailing inline comment if present (e.g. `Foo=1 ; explanation`). Kept as the leading `;` + body. */
  trailingComment?: string
  directive?: PatchDirective
}

export interface IniSection {
  /** `[Section]` line text, trimmed. `null` for the preamble before any header. */
  header: string | null
  /** Directive that was attached to this section via a leading `; @ReHoarder: <Name>` comment. */
  sectionDirective: PatchDirective
  lines: IniLine[]
}

export interface IniDocument {
  sections: IniSection[]
}

export interface PatchResult {
  scalarsOverridden: number
  scalarsAdded: number
  arraysReplaced: number
  sectionsCommented: number
  sectionsAdded: number
  warnings: string[]
}

const DIRECTIVE_PREFIX = '@ReHoarder:'
const SENTINEL_RE = /^\s*;\s*===\s*Patched by ReHoarder/

// ---------------- Sentinel ----------------

export function hasSentinel(fileContent: string): boolean {
  const first = fileContent.split(/\r?\n/, 1)[0] ?? ''
  return SENTINEL_RE.test(first)
}

/** SHA1 of the master, first 8 hex chars — enough to detect drift without verbosity. */
export function computeMasterHash(masterContent: string): string {
  return crypto.createHash('sha1').update(masterContent, 'utf-8').digest('hex').slice(0, 8)
}

export function buildSentinelLine(masterHash8: string): string {
  const now = new Date().toISOString().replace(/\.\d{3}Z$/, '')
  return `; === Patched by ReHoarder ${now} (master: ${masterHash8}) ===`
}

export function stripSentinelHeader(content: string): string {
  if (!hasSentinel(content)) return content
  const lines = content.split(/\r?\n/)
  const out: string[] = []
  let dropped = false
  for (const line of lines) {
    if (!dropped && SENTINEL_RE.test(line)) {
      dropped = true
      continue
    }
    if (dropped && out.length === 0 && line.trim() === '') continue
    out.push(line)
  }
  return out.join('\r\n')
}

// ---------------- Parsing ----------------

export function parseIni(text: string): IniDocument {
  const doc: IniDocument = { sections: [] }
  let current: IniSection = { header: null, sectionDirective: 'none', lines: [] }
  doc.sections.push(current)
  let pendingDirective: PatchDirective = 'none'

  for (const rawLine of text.split(/\r?\n/)) {
    const line = parseLine(rawLine)
    if (line.kind === 'sectionHeader') {
      current = {
        header: rawLine.trim(),
        sectionDirective: pendingDirective,
        lines: []
      }
      pendingDirective = 'none'
      doc.sections.push(current)
      current.lines.push(line)
      continue
    }
    if (line.kind === 'directive') {
      pendingDirective = line.directive ?? 'none'
      current.lines.push(line)
      continue
    }
    if (line.kind !== 'blank' && line.kind !== 'comment') {
      // Any non-comment content breaks the directive-attaches-to-next-section
      // contract.
      pendingDirective = 'none'
    }
    current.lines.push(line)
  }
  return doc
}

function parseLine(raw: string): IniLine {
  const trimmed = raw.trim()
  if (trimmed.length === 0) return { raw, kind: 'blank' }
  if (trimmed.startsWith(';')) {
    const directive = tryParseDirective(trimmed)
    return {
      raw,
      kind: directive !== 'none' ? 'directive' : 'comment',
      directive
    }
  }
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    return { raw, kind: 'sectionHeader' }
  }
  const isArrayAdd = trimmed.startsWith('+')
  const keyStart = isArrayAdd ? 1 : 0
  const eqIdx = trimmed.indexOf('=')
  if (eqIdx <= keyStart) {
    // Treat as comment-ish unknown line — preserved on round-trip.
    return { raw, kind: 'comment' }
  }
  const key = trimmed.slice(keyStart, eqIdx).trim()
  const rest = trimmed.slice(eqIdx + 1)
  const { value, trailingComment } = splitTrailingComment(rest)
  return {
    raw,
    kind: isArrayAdd ? 'arrayAdd' : 'scalar',
    key,
    value,
    trailingComment
  }
}

function tryParseDirective(trimmedCommentLine: string): PatchDirective {
  const semi = trimmedCommentLine.indexOf(';')
  if (semi < 0) return 'none'
  const body = trimmedCommentLine.slice(semi + 1).trimStart()
  if (!body.startsWith(DIRECTIVE_PREFIX)) return 'none'
  const name = body.slice(DIRECTIVE_PREFIX.length).trim()
  if (name === 'CommentAll') return 'commentAll'
  if (name === 'AppendArray') return 'appendArray'
  return 'none'
}

/**
 * Find a `<space>;` that terminates the scalar value and start a trailing
 * comment. Respects double-quoted strings and balanced parentheses, so values
 * with semicolons inside `(...)` or `"..."` are kept intact.
 */
function splitTrailingComment(rest: string): { value: string; trailingComment?: string } {
  let depthParen = 0
  let inQuote = false
  for (let i = 0; i < rest.length; i++) {
    const c = rest[i]
    if (c === '"' && (i === 0 || rest[i - 1] !== '\\')) inQuote = !inQuote
    if (inQuote) continue
    if (c === '(') depthParen++
    else if (c === ')') depthParen = Math.max(0, depthParen - 1)
    else if (c === ';' && depthParen === 0 && i > 0 && /\s/.test(rest[i - 1])) {
      return { value: rest.slice(0, i).trimEnd(), trailingComment: rest.slice(i) }
    }
  }
  return { value: rest.trimEnd() }
}

// ---------------- Serialization ----------------

export function serializeIni(doc: IniDocument): string {
  let out = ''
  for (const section of doc.sections) {
    for (const line of section.lines) {
      out += line.raw + '\r\n'
    }
  }
  return out
}

// ---------------- Merge ----------------

export function applyMerge(engineDoc: IniDocument, masterDoc: IniDocument): PatchResult {
  let scalarsOverridden = 0
  let scalarsAdded = 0
  let arraysReplaced = 0
  let sectionsCommented = 0
  let sectionsAdded = 0
  const warnings: string[] = []

  for (const mSection of masterDoc.sections) {
    if (mSection.header === null) continue // Skip master preamble — documentation only.

    if (mSection.sectionDirective === 'commentAll') {
      const target = findSection(engineDoc, mSection.header)
      if (!target) {
        appendSectionVerbatim(engineDoc, mSection)
        sectionsAdded++
        continue
      }
      commentOutSection(target)
      const added = appendMasterBodyToSection(target, mSection)
      scalarsAdded += added
      sectionsCommented++
      continue
    }

    if (mSection.sectionDirective === 'appendArray') {
      warnings.push(
        `AppendArray directive on section '${mSection.header}' is reserved for v2; section skipped.`
      )
      continue
    }

    const engineSection = findSection(engineDoc, mSection.header)
    if (!engineSection) {
      appendSectionVerbatim(engineDoc, mSection)
      sectionsAdded++
      continue
    }
    const counts = mergeScalarsAndArrays(engineSection, mSection)
    scalarsOverridden += counts.scalarsOverridden
    scalarsAdded += counts.scalarsAdded
    arraysReplaced += counts.arraysReplaced
  }

  return {
    scalarsOverridden,
    scalarsAdded,
    arraysReplaced,
    sectionsCommented,
    sectionsAdded,
    warnings
  }
}

export function summarisePatchResult(r: PatchResult): string {
  const parts: string[] = []
  if (r.scalarsOverridden > 0)
    parts.push(`${r.scalarsOverridden} scalar${r.scalarsOverridden === 1 ? '' : 's'} overridden`)
  if (r.scalarsAdded > 0)
    parts.push(`${r.scalarsAdded} scalar${r.scalarsAdded === 1 ? '' : 's'} added`)
  if (r.arraysReplaced > 0)
    parts.push(`${r.arraysReplaced} array${r.arraysReplaced === 1 ? '' : 's'} replaced`)
  if (r.sectionsCommented > 0)
    parts.push(`${r.sectionsCommented} section${r.sectionsCommented === 1 ? '' : 's'} commented`)
  if (r.sectionsAdded > 0)
    parts.push(`${r.sectionsAdded} section${r.sectionsAdded === 1 ? '' : 's'} added`)
  if (parts.length === 0) parts.push('no changes')
  let result = parts.join(', ')
  if (r.warnings.length > 0) {
    result += ` (${r.warnings.length} warning${r.warnings.length === 1 ? '' : 's'})`
  }
  return result
}

function findSection(doc: IniDocument, header: string): IniSection | null {
  for (const s of doc.sections) {
    if (s.header !== null && s.header.toLowerCase() === header.toLowerCase()) return s
  }
  return null
}

function commentOutSection(section: IniSection): void {
  for (let i = 0; i < section.lines.length; i++) {
    const l = section.lines[i]
    if (
      l.kind === 'blank' ||
      l.kind === 'sectionHeader' ||
      l.kind === 'comment' ||
      l.kind === 'directive'
    ) {
      continue
    }
    section.lines[i] = {
      raw: '; ' + l.raw.replace(/^\s+/, ''),
      kind: 'comment'
    }
  }
}

/**
 * Append non-header lines from a `commentAll` master section to the engine
 * section so user-added overrides survive the comment-out pass. Returns the
 * count of scalar adds for the stats.
 */
function appendMasterBodyToSection(engineSection: IniSection, masterSection: IniSection): number {
  let hasBody = false
  for (const l of masterSection.lines) {
    if (l.kind === 'sectionHeader') continue
    if (l.kind !== 'blank' && l.kind !== 'comment') {
      hasBody = true
      break
    }
  }
  if (!hasBody) return 0
  if (
    engineSection.lines.length > 0 &&
    engineSection.lines[engineSection.lines.length - 1].kind !== 'blank'
  ) {
    engineSection.lines.push({ raw: '', kind: 'blank' })
  }
  let scalarsAdded = 0
  for (const l of masterSection.lines) {
    if (l.kind === 'sectionHeader') continue
    engineSection.lines.push({ ...l })
    if (l.kind === 'scalar') scalarsAdded++
  }
  return scalarsAdded
}

function appendSectionVerbatim(engineDoc: IniDocument, masterSection: IniSection): void {
  const last = engineDoc.sections[engineDoc.sections.length - 1]
  if (last && last.lines.length > 0 && last.lines[last.lines.length - 1].kind !== 'blank') {
    last.lines.push({ raw: '', kind: 'blank' })
  }
  const copy: IniSection = {
    header: masterSection.header,
    sectionDirective: 'none',
    lines: masterSection.lines.map((l) => ({ ...l }))
  }
  engineDoc.sections.push(copy)
}

function mergeScalarsAndArrays(
  engineSection: IniSection,
  masterSection: IniSection
): { scalarsOverridden: number; scalarsAdded: number; arraysReplaced: number } {
  let scalarsOverridden = 0
  let scalarsAdded = 0
  let arraysReplaced = 0

  const multiKeys = findMultiValueKeys(masterSection)

  // Array-style merge for multi-value keys (and explicit `+Key=`).
  const arrayBlocks = extractValueBlocks(masterSection, multiKeys)
  for (const [arrayKey, block] of arrayBlocks) {
    let insertAt = removeKeyFromSection(engineSection, arrayKey)
    if (insertAt < 0) insertAt = findInsertionEndOfSection(engineSection)
    for (let i = 0; i < block.length; i++) {
      engineSection.lines.splice(insertAt + i, 0, { ...block[i] })
    }
    arraysReplaced++
  }

  // Scalar merge for single-value keys.
  for (const mLine of masterSection.lines) {
    if (mLine.kind !== 'scalar') continue
    const key = mLine.key
    if (!key) continue
    if (multiKeys.has(key.toLowerCase())) continue

    const engineIdx = findScalarIndex(engineSection, key)
    if (engineIdx >= 0) {
      engineSection.lines[engineIdx] = { ...mLine, kind: 'scalar' }
      scalarsOverridden++
    } else {
      const insertAt = findInsertionEndOfSection(engineSection)
      engineSection.lines.splice(insertAt, 0, { ...mLine, kind: 'scalar' })
      scalarsAdded++
    }
  }

  return { scalarsOverridden, scalarsAdded, arraysReplaced }
}

function findMultiValueKeys(section: IniSection): Set<string> {
  // Lowercased keys for case-insensitive matching, matching UE's semantics.
  const counts = new Map<string, number>()
  for (const l of section.lines) {
    if ((l.kind === 'scalar' || l.kind === 'arrayAdd') && l.key) {
      const k = l.key.toLowerCase()
      counts.set(k, (counts.get(k) ?? 0) + 1)
    }
  }
  const result = new Set<string>()
  for (const [k, n] of counts) {
    if (n > 1) result.add(k)
  }
  for (const l of section.lines) {
    if (l.kind === 'arrayAdd' && l.key) result.add(l.key.toLowerCase())
  }
  return result
}

function findScalarIndex(section: IniSection, key: string): number {
  for (let i = 0; i < section.lines.length; i++) {
    const l = section.lines[i]
    if (l.kind === 'scalar' && l.key && l.key.toLowerCase() === key.toLowerCase()) return i
  }
  return -1
}

function findInsertionEndOfSection(section: IniSection): number {
  let idx = section.lines.length
  while (idx > 0 && section.lines[idx - 1].kind === 'blank') idx--
  return idx
}

function extractValueBlocks(
  master: IniSection,
  keys: Set<string>
): Array<[string, IniLine[]]> {
  const result: Array<[string, IniLine[]]> = []
  if (keys.size === 0) return result
  const lines = master.lines
  const emitted = new Set<string>()
  let i = 0
  while (i < lines.length) {
    const lk = lines[i]
    if (
      (lk.kind !== 'scalar' && lk.kind !== 'arrayAdd') ||
      !lk.key ||
      !keys.has(lk.key.toLowerCase())
    ) {
      i++
      continue
    }
    const key = lk.key.toLowerCase()
    if (emitted.has(key)) {
      i++
      continue
    }
    // Walk backward over attached comments / directives.
    let blockStart = i
    let j = i - 1
    while (j >= 0 && (lines[j].kind === 'comment' || lines[j].kind === 'directive')) {
      blockStart = j
      j--
    }
    const block: IniLine[] = []
    for (let k = blockStart; k < i; k++) block.push({ ...lines[k] })
    for (let k = i; k < lines.length; k++) {
      const l = lines[k]
      if (
        (l.kind === 'scalar' || l.kind === 'arrayAdd') &&
        l.key &&
        l.key.toLowerCase() === key
      ) {
        block.push({ ...l })
      }
    }
    result.push([lk.key, block])
    emitted.add(key)
    i++
  }
  return result
}

function removeKeyFromSection(section: IniSection, key: string): number {
  let firstRemoved = -1
  for (let i = section.lines.length - 1; i >= 0; i--) {
    const l = section.lines[i]
    if (
      (l.kind === 'scalar' || l.kind === 'arrayAdd') &&
      l.key &&
      l.key.toLowerCase() === key.toLowerCase()
    ) {
      section.lines.splice(i, 1)
      firstRemoved = i
    }
  }
  return firstRemoved
}
