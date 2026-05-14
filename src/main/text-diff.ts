/**
 * Minimal LCS-based line diff for the preview dialog. Produces a sequence of
 * ops the renderer can fold into a two-column view:
 *   - `same`  → both columns show the line at the same row
 *   - `remove`→ left column shows the line, right is blank
 *   - `add`   → left blank, right shows the line
 *
 * O(m·n) time and memory which is fine for typical Engine/Config/*.ini files
 * (a few hundred lines on each side). For larger inputs an in-place Myers
 * implementation would be more memory-efficient, but the simplicity here
 * pays off in clarity and ease of audit.
 */

export type DiffOpKind = 'same' | 'remove' | 'add'

export interface DiffOp {
  kind: DiffOpKind
  /** Line text without the trailing newline. */
  text: string
  /** 1-based line number in the source (left side). Undefined when kind === 'add'. */
  leftLine?: number
  /** 1-based line number in the target (right side). Undefined when kind === 'remove'. */
  rightLine?: number
}

export function diffLines(beforeText: string, afterText: string): DiffOp[] {
  const before = splitLinesRetainingEmptyTail(beforeText)
  const after = splitLinesRetainingEmptyTail(afterText)
  const lcs = buildLcs(before, after)

  const ops: DiffOp[] = []
  let i = 0
  let j = 0
  while (i < before.length || j < after.length) {
    if (i < before.length && j < after.length && before[i] === after[j]) {
      ops.push({ kind: 'same', text: before[i], leftLine: i + 1, rightLine: j + 1 })
      i++
      j++
      continue
    }
    // Pick the direction the LCS table tells us is the longer common subsequence.
    const down = j + 1 <= after.length ? lcs[i][j + 1] : -1
    const right = i + 1 <= before.length ? lcs[i + 1][j] : -1
    if (down >= right) {
      ops.push({ kind: 'add', text: after[j], rightLine: j + 1 })
      j++
    } else {
      ops.push({ kind: 'remove', text: before[i], leftLine: i + 1 })
      i++
    }
  }
  return ops
}

/**
 * Split on `\r?\n` keeping every line — including a final empty string when
 * the input ends with a newline (so a diff that adds a trailing newline is
 * visible). Empty input returns `[]` (no spurious blank line).
 */
function splitLinesRetainingEmptyTail(s: string): string[] {
  if (s.length === 0) return []
  return s.split(/\r?\n/)
}

function buildLcs(a: string[], b: string[]): number[][] {
  const m = a.length
  const n = b.length
  // dp[i][j] = LCS length of a[i..m] vs b[j..n]. Rolling from the end so
  // forward consumption matches the natural diff walk above.
  const dp: number[][] = []
  for (let i = 0; i <= m; i++) dp.push(new Array<number>(n + 1).fill(0))
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      if (a[i] === b[j]) dp[i][j] = dp[i + 1][j + 1] + 1
      else dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }
  return dp
}
