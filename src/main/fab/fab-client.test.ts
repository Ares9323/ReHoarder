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
    // URL carries a per-call cache-bust timestamp (`&_=<ms>`) so CDN caches
    // can't pin stale `images[0].url`. Match the stable prefix and assert
    // the bust is a numeric value rather than nailing the exact string.
    expect(url).toMatch(
      /^https:\/\/www\.fab\.com\/e\/accounts\/acct-1\/ue\/library\?count=100&_=\d+$/
    )
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
