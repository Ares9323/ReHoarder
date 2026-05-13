import { EPIC_USER_AGENT } from './user-agent'

const LAUNCHER_ASSETS_ENDPOINT =
  'https://launcher-public-service-prod06.ol.epicgames.com/launcher/api/public/assets/Windows?label=Live'

const CATALOG_BULK_ENDPOINT =
  'https://catalog-public-service-prod06.ol.epicgames.com/catalog/api/shared/bulk/items' +
  '?includeDLCDetails=false&includeMainGameDetails=false&country=US&locale=en'

const CATALOG_BATCH_SIZE = 50

export interface VaultAssetSummary {
  namespace: string
  catalogItemId: string
  appName: string
  labelName: string
  buildVersion?: string
}

export interface CatalogItem {
  id: string
  title?: string
  description?: string
  longDescription?: string
  keyImages?: Array<{ type: string; url: string }>
  categories?: Array<{ path: string }>
  creationDate?: string
}

export class VaultClient {
  constructor(private readonly fetchImpl: typeof fetch = globalThis.fetch) {}

  async listOwnedAssets(accessToken: string): Promise<VaultAssetSummary[]> {
    const response = await this.fetchImpl(LAUNCHER_ASSETS_ENDPOINT, {
      method: 'GET',
      headers: {
        Authorization: `bearer ${accessToken}`,
        'User-Agent': EPIC_USER_AGENT,
        Accept: 'application/json'
      }
    })
    if (!response.ok) {
      throw new Error(`Launcher assets API returned ${response.status}`)
    }
    return (await response.json()) as VaultAssetSummary[]
  }

  async fetchCatalogMetadata(
    accessToken: string,
    catalogItemIds: string[]
  ): Promise<Record<string, CatalogItem>> {
    if (catalogItemIds.length === 0) return {}

    const merged: Record<string, CatalogItem> = {}

    for (let i = 0; i < catalogItemIds.length; i += CATALOG_BATCH_SIZE) {
      const batch = catalogItemIds.slice(i, i + CATALOG_BATCH_SIZE)
      const body = batch.map((id) => `id=${encodeURIComponent(id)}`).join('&')

      const response = await this.fetchImpl(CATALOG_BULK_ENDPOINT, {
        method: 'POST',
        headers: {
          Authorization: `bearer ${accessToken}`,
          'User-Agent': EPIC_USER_AGENT,
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json'
        },
        body
      })
      if (!response.ok) {
        throw new Error(`Catalog API returned ${response.status}`)
      }
      const json = (await response.json()) as Record<string, CatalogItem>
      Object.assign(merged, json)
    }

    return merged
  }
}
