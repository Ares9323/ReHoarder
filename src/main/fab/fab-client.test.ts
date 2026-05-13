import { describe, it, expect, vi, beforeEach } from 'vitest'
import { FabClient } from './fab-client'

let fetchMock: ReturnType<typeof vi.fn>
let client: FabClient

beforeEach(() => {
  fetchMock = vi.fn()
  client = new FabClient(fetchMock as unknown as typeof fetch)
})

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  })
}

describe('FabClient.listLibrary', () => {
  it('makes one request for a single-page library and yields the page', async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(
        jsonResponse({
          results: [{ assetId: 'a-1', title: 'One' }],
          cursors: { next: null }
        })
      )
    )

    const pages: Array<Array<{ assetId: string }>> = []
    for await (const page of client.listLibrary('the-bearer', 'cookies=here', 'acct-1')) {
      pages.push(page.results as Array<{ assetId: string }>)
    }

    expect(pages).toHaveLength(1)
    expect(pages[0]).toHaveLength(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://www.fab.com/e/accounts/acct-1/ue/library?count=100')
    expect(init.headers['Authorization']).toBe('bearer the-bearer')
    expect(init.headers['Cookie']).toBe('cookies=here')
  })

  it('walks the cursor until next is null, yielding each page', async () => {
    fetchMock
      .mockImplementationOnce(() =>
        Promise.resolve(
          jsonResponse({
            results: [{ assetId: 'a-1' }, { assetId: 'a-2' }],
            cursors: { next: 'CURSOR-2' }
          })
        )
      )
      .mockImplementationOnce(() =>
        Promise.resolve(
          jsonResponse({
            results: [{ assetId: 'a-3' }],
            cursors: { next: null }
          })
        )
      )

    const allIds: string[] = []
    for await (const page of client.listLibrary('t', 'c', 'acct')) {
      for (const r of page.results as Array<{ assetId: string }>) allIds.push(r.assetId)
    }
    expect(allIds).toEqual(['a-1', 'a-2', 'a-3'])

    const secondUrl = fetchMock.mock.calls[1][0]
    expect(secondUrl).toContain('cursor=CURSOR-2')
  })

  it('throws on non-2xx', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(jsonResponse({}, 401)))
    const iter = client.listLibrary('t', 'c', 'acct')
    await expect(iter.next()).rejects.toThrow(/401/)
  })
})

describe('FabClient.listOtherLibrary', () => {
  it('builds the request with sort_by, source=acquired and all 16 asset_formats', async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(
        jsonResponse({
          results: [{ listing: { uid: 'l-1', title: 'One' } }],
          next: null
        })
      )
    )

    for await (const _page of client.listOtherLibrary('the-cookies')) {
      void _page
    }

    const [url, init] = fetchMock.mock.calls[0]
    const u = new URL(url as string)
    expect(u.pathname).toBe('/i/library/search')
    expect(u.hostname).toBe('www.fab.com')
    expect(u.searchParams.get('sort_by')).toBe('-createdAt')
    expect(u.searchParams.get('source')).toBe('acquired')
    expect(u.searchParams.getAll('asset_formats')).toHaveLength(16)
    expect(u.searchParams.getAll('asset_formats')).toContain('blender')
    expect(u.searchParams.getAll('asset_formats')).toContain('metahuman')
    expect(u.searchParams.getAll('asset_formats')).toContain('unity')
    expect(init.headers['Cookie']).toBe('the-cookies')
    expect(init.headers['Referer']).toBe('https://www.fab.com/library')
    expect(init.headers['X-Requested-With']).toBe('XMLHttpRequest')
    // No bearer on /i/* calls — cookie-only
    expect(init.headers['Authorization']).toBeUndefined()
  })

  it('walks the next URL until null, yielding each page', async () => {
    const nextUrl =
      'https://www.fab.com/i/library/search?cursor=abc&asset_formats=blender'
    fetchMock
      .mockImplementationOnce(() =>
        Promise.resolve(
          jsonResponse({
            results: [{ listing: { uid: 'l-1', title: 'One' } }],
            next: nextUrl
          })
        )
      )
      .mockImplementationOnce(() =>
        Promise.resolve(
          jsonResponse({
            results: [{ listing: { uid: 'l-2', title: 'Two' } }],
            next: null
          })
        )
      )

    const uids: string[] = []
    for await (const page of client.listOtherLibrary('c')) {
      for (const r of page.results) uids.push(r.listing.uid)
    }

    expect(uids).toEqual(['l-1', 'l-2'])
    expect(fetchMock.mock.calls[1][0]).toBe(nextUrl)
  })

  it('returns empty (no throw) on 204', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(new Response(null, { status: 204 })))
    const pages = []
    for await (const p of client.listOtherLibrary('c')) pages.push(p)
    expect(pages).toEqual([])
  })

  it('throws on non-2xx other than 204', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(jsonResponse({}, 500)))
    const iter = client.listOtherLibrary('c')
    await expect(iter.next()).rejects.toThrow(/500/)
  })
})
