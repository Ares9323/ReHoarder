/**
 * Minimal in-memory cookie jar for the 9-step Epic→Fab session handshake.
 *
 * Scope: covers the small set of cookie-bearing endpoints we hit during sync
 * (epicgames.com, fab.com, unrealengine.com). NOT a general-purpose RFC 6265
 * implementation. See docs/superpowers/specs/2026-05-12-fab-real-handshake-design.md
 * for the YAGNI list of what we deliberately do NOT do.
 */

export interface CookieJar {
  captureFromResponse(requestUrl: URL, responseHeaders: Headers): void
  getCookieHeader(requestUrl: URL): string
  getCookieValue(requestUrl: URL, name: string): string | undefined
  /**
   * Enumerate all stored cookies. Used when transferring our jar's state
   * into an Electron session partition (BrowserWindow-driven Fab login).
   * Each entry yields the bucket suffix (e.g. ".epicgames.com" or
   * "www.epicgames.com" for host-bound cookies) plus name/value.
   */
  entries(): Iterable<{ suffix: string; name: string; value: string }>
}

const PUBLIC_TLDS = new Set([
  '.com', '.org', '.net', '.io', '.dev', '.app', '.co', '.us', '.uk', '.eu'
])

interface ParsedSetCookie {
  name: string
  value: string
  domain?: string
}

export class InMemoryCookieJar implements CookieJar {
  // Map<hostSuffix (e.g. ".fab.com" OR "www.epicgames.com"), Map<name, value>>
  private buckets = new Map<string, Map<string, string>>()

  captureFromResponse(requestUrl: URL, responseHeaders: Headers): void {
    for (const raw of collectSetCookies(responseHeaders)) {
      const parsed = parseSetCookie(raw)
      if (!parsed) continue
      const suffix = determineSuffix(parsed.domain, requestUrl.hostname)
      if (!isAllowedSuffix(suffix, requestUrl.hostname)) continue
      let bucket = this.buckets.get(suffix)
      if (!bucket) {
        bucket = new Map()
        this.buckets.set(suffix, bucket)
      }
      bucket.set(parsed.name, parsed.value)
    }
  }

  getCookieHeader(requestUrl: URL): string {
    const pairs: string[] = []
    const host = requestUrl.hostname.toLowerCase()
    // Iterate longest suffix first so more-specific cookies overwrite generic ones
    const suffixes = Array.from(this.buckets.keys()).sort((a, b) => b.length - a.length)
    const seen = new Set<string>()
    for (const suffix of suffixes) {
      if (!suffixMatches(suffix, host)) continue
      const bucket = this.buckets.get(suffix)!
      for (const [name, value] of bucket) {
        if (seen.has(name)) continue
        seen.add(name)
        pairs.push(`${name}=${value}`)
      }
    }
    return pairs.join('; ')
  }

  getCookieValue(requestUrl: URL, name: string): string | undefined {
    const host = requestUrl.hostname.toLowerCase()
    const suffixes = Array.from(this.buckets.keys()).sort((a, b) => b.length - a.length)
    for (const suffix of suffixes) {
      if (!suffixMatches(suffix, host)) continue
      const bucket = this.buckets.get(suffix)!
      const v = bucket.get(name)
      if (v !== undefined) return v
    }
    return undefined
  }

  *entries(): Iterable<{ suffix: string; name: string; value: string }> {
    for (const [suffix, bucket] of this.buckets) {
      for (const [name, value] of bucket) {
        yield { suffix, name, value }
      }
    }
  }
}

function collectSetCookies(headers: Headers): string[] {
  const getSetCookie = (headers as Headers & { getSetCookie?: () => string[] }).getSetCookie
  if (typeof getSetCookie === 'function') {
    const raw = getSetCookie.call(headers)
    if (raw.length > 0) return raw
  }
  const combined = headers.get('set-cookie')
  if (!combined) return []
  return combined.split(/,(?=\s*[A-Za-z0-9_-]+=)/)
}

function parseSetCookie(raw: string): ParsedSetCookie | null {
  const segments = raw.split(';').map((s) => s.trim())
  if (segments.length === 0 || !segments[0].includes('=')) return null
  const eq = segments[0].indexOf('=')
  const name = segments[0].slice(0, eq).trim()
  const value = segments[0].slice(eq + 1).trim()
  if (!name) return null
  let domain: string | undefined
  for (let i = 1; i < segments.length; i++) {
    const lower = segments[i].toLowerCase()
    if (lower.startsWith('domain=')) {
      domain = segments[i].slice('domain='.length).trim().toLowerCase()
    }
  }
  return { name, value, domain }
}

function determineSuffix(domain: string | undefined, requestHost: string): string {
  if (!domain) return requestHost.toLowerCase()
  // Normalize "fab.com" → ".fab.com" (a Domain attribute without a leading dot
  // is still scope-broader than the request host alone; we treat it as a suffix).
  return domain.startsWith('.') ? domain : `.${domain}`
}

function isAllowedSuffix(suffix: string, requestHost: string): boolean {
  const host = requestHost.toLowerCase()
  if (PUBLIC_TLDS.has(suffix)) return false
  if (suffix.startsWith('.')) {
    // request host must be that suffix or end with it
    return host === suffix.slice(1) || host.endsWith(suffix)
  }
  return host === suffix
}

function suffixMatches(suffix: string, host: string): boolean {
  if (suffix.startsWith('.')) {
    return host === suffix.slice(1) || host.endsWith(suffix)
  }
  return host === suffix
}
