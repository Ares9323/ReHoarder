import { describe, it, expect, vi, beforeEach } from 'vitest'
import { VaultClient } from './vault-client'

let fetchMock: ReturnType<typeof vi.fn>
let client: VaultClient

beforeEach(() => {
  fetchMock = vi.fn()
  client = new VaultClient(fetchMock as unknown as typeof fetch)
})

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  })
}

describe('VaultClient.listOwnedAssets', () => {
  it('GETs launcher API with bearer + EpicGamesLauncher UA, returns parsed array', async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(
        jsonResponse([
          {
            namespace: 'ue',
            catalogItemId: 'cat-1',
            appName: 'AssetOne',
            labelName: 'Live',
            buildVersion: '4.27.0-Live'
          }
        ])
      )
    )

    const result = await client.listOwnedAssets('the-bearer')

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe(
      'https://launcher-public-service-prod06.ol.epicgames.com/launcher/api/public/assets/Windows?label=Live'
    )
    expect(init.headers['Authorization']).toBe('bearer the-bearer')
    expect(init.headers['User-Agent']).toMatch(/^EpicGamesLauncher\//)
    expect(result).toHaveLength(1)
    expect(result[0].catalogItemId).toBe('cat-1')
  })

  it('throws on non-2xx', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(jsonResponse({ error: 'nope' }, 401)))
    await expect(client.listOwnedAssets('dead-bearer')).rejects.toThrow(/401/)
  })
})

describe('VaultClient.fetchCatalogMetadata', () => {
  it('POSTs to the catalog bulk endpoint with id=... params for each catalogItemId', async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(
        jsonResponse({
          'cat-1': {
            id: 'cat-1',
            title: 'Asset One',
            description: 'Nice',
            keyImages: [{ type: 'Thumbnail', url: 'https://img/1.png' }],
            categories: [{ path: 'assets/megapacks' }]
          },
          'cat-2': {
            id: 'cat-2',
            title: 'Asset Two',
            description: 'Also nice',
            keyImages: [],
            categories: []
          }
        })
      )
    )

    const result = await client.fetchCatalogMetadata('the-bearer', ['cat-1', 'cat-2'])

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toContain(
      'catalog-public-service-prod06.ol.epicgames.com/catalog/api/shared/bulk/items'
    )
    expect(init.method).toBe('POST')
    expect(init.headers['Authorization']).toBe('bearer the-bearer')
    expect(init.headers['Content-Type']).toBe('application/x-www-form-urlencoded')
    expect(init.body).toBe('id=cat-1&id=cat-2')
    expect(Object.keys(result).sort()).toEqual(['cat-1', 'cat-2'])
  })

  it('chunks the request when more than 50 IDs are passed (Epic limits batch size)', async () => {
    const ids = Array.from({ length: 75 }, (_, i) => `c-${i}`)
    fetchMock.mockImplementation(() => Promise.resolve(jsonResponse({})))

    await client.fetchCatalogMetadata('the-bearer', ids)

    expect(fetchMock).toHaveBeenCalledTimes(2)
    const body0 = fetchMock.mock.calls[0][1].body as string
    const body1 = fetchMock.mock.calls[1][1].body as string
    expect(body0.split('&').length).toBe(50)
    expect(body1.split('&').length).toBe(25)
  })

  it('returns an empty object when given an empty ID array (no request made)', async () => {
    const result = await client.fetchCatalogMetadata('the-bearer', [])
    expect(result).toEqual({})
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
