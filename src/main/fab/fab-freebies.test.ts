import { describe, it, expect, vi } from 'vitest'
import { FabFreebiesClient } from './fab-freebies'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  })
}

describe('FabFreebiesClient.listFreebies', () => {
  it('maps blade tiles to freebies and makes exactly one HTTP call (no listings-states)', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      jsonResponse({
        results: [
          {
            listing: {
              uid: 'uid-A',
              title: 'Asset A',
              slug: 'asset-a',
              images: [{ url: 'https://img/a.png' }]
            }
          }
        ]
      })
    )
    const client = new FabFreebiesClient(fetchMock as unknown as typeof fetch)
    const freebies = await client.listFreebies('fab_sessionid=x')

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][0]).toBe(
      'https://www.fab.com/i/blades/free_content_blade'
    )
    expect(freebies).toHaveLength(1)
    expect(freebies[0].uid).toBe('uid-A')
    expect(freebies[0].title).toBe('Asset A')
    expect(freebies[0].imageUrl).toBe('https://img/a.png')
    expect(freebies[0].productUrl).toBe('https://www.fab.com/listings/uid-A/asset-a')
    // No network enrichment: claimed is never set by the client.
    expect(freebies[0].claimed).toBeUndefined()
  })

  it('throws when the blade endpoint returns a non-ok status', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(null, { status: 403 }))
    const client = new FabFreebiesClient(fetchMock as unknown as typeof fetch)
    await expect(client.listFreebies('fab_sessionid=x')).rejects.toThrow(/403/)
  })

  it('returns an empty array when the blade has no tiles', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({ results: [] }))
    const client = new FabFreebiesClient(fetchMock as unknown as typeof fetch)
    expect(await client.listFreebies('fab_sessionid=x')).toEqual([])
  })
})
