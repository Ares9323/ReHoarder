import { describe, it, expect } from 'vitest'
import {
  normalizeVaultAsset,
  normalizeFabAsset,
  normalizeFabEntitlement
} from './normalize'
import type { CatalogItem, VaultAssetSummary } from '../vault/vault-client'
import type { FabLibraryItem } from '../fab/fab-client'

describe('normalizeVaultAsset', () => {
  it('produces an AssetRow with vault source and the catalog title/description', () => {
    const summary: VaultAssetSummary = {
      namespace: 'ue',
      catalogItemId: 'cat-1',
      appName: 'TestApp',
      labelName: 'Live'
    }
    const catalog: CatalogItem = {
      id: 'cat-1',
      title: 'Test Asset',
      description: 'A short desc',
      keyImages: [
        { type: 'Thumbnail', url: 'https://img/thumb.png' },
        { type: 'DieselGameBoxLogo', url: 'https://img/logo.png' }
      ],
      categories: [{ path: 'assets/megapacks' }],
      creationDate: '2024-01-01T00:00:00.000Z'
    }
    const now = 1_700_000_000_000

    const row = normalizeVaultAsset(summary, catalog, now)

    expect(row).toMatchObject({
      source: 'vault',
      sourceId: 'cat-1',
      title: 'Test Asset',
      description: 'A short desc',
      imageUrl: 'https://img/thumb.png',
      ownedAt: new Date('2024-01-01T00:00:00.000Z').getTime(),
      hidden: false,
      syncedAt: 1_700_000_000_000
    })
    expect(row.productUrl).toBeNull()
    expect(row.raw).toBeTruthy()
  })

  it('falls back to appName when catalog has no title (defensive)', () => {
    const summary: VaultAssetSummary = {
      namespace: 'ue',
      catalogItemId: 'cat-x',
      appName: 'FallbackApp',
      labelName: 'Live'
    }
    const catalog = { id: 'cat-x' } as CatalogItem
    const row = normalizeVaultAsset(summary, catalog, 0)
    expect(row.title).toBe('FallbackApp')
  })

  it('picks any image when "Thumbnail" type is absent', () => {
    const catalog: CatalogItem = {
      id: 'cat-1',
      title: 'X',
      keyImages: [{ type: 'OfferImageWide', url: 'https://img/wide.png' }]
    }
    const row = normalizeVaultAsset(
      { namespace: 'ue', catalogItemId: 'cat-1', appName: 'X', labelName: 'Live' },
      catalog,
      0
    )
    expect(row.imageUrl).toBe('https://img/wide.png')
  })
})

describe('normalizeFabAsset', () => {
  it('produces an AssetRow with fab source from a Fab library item (camelCase fields)', () => {
    const item: FabLibraryItem = {
      assetId: 'fab-abc',
      title: 'Fab Asset',
      description: 'From Fab',
      images: [{ url: 'https://img/fab.png', type: 'Thumbnail' }],
      customAttributes: [{ ListingIdentifier: 'market-uuid-1234' }]
    }
    const row = normalizeFabAsset(item, 1_700_000_000_000)
    expect(row).toMatchObject({
      source: 'fab',
      sourceId: 'fab-abc',
      title: 'Fab Asset',
      description: 'From Fab',
      imageUrl: 'https://img/fab.png',
      productUrl: 'https://www.fab.com/listings/market-uuid-1234',
      ownedAt: null,
      hidden: false,
      syncedAt: 1_700_000_000_000
    })
  })

  it('handles missing optional fields gracefully', () => {
    const item = { assetId: 'fab-x', title: 'Minimal' } as FabLibraryItem
    const row = normalizeFabAsset(item, 0)
    expect(row.description).toBeNull()
    expect(row.imageUrl).toBeNull()
    expect(row.ownedAt).toBeNull()
    expect(row.productUrl).toBeNull()
  })

  it('falls back to images[0].url when present without customAttributes', () => {
    const item: FabLibraryItem = {
      assetId: 'fab-y',
      title: 'No CA',
      images: [{ url: 'https://img/a.png' }, { url: 'https://img/b.png' }]
    }
    const row = normalizeFabAsset(item, 0)
    expect(row.imageUrl).toBe('https://img/a.png')
  })

  it('derives the Fab listing URL from item.url when customAttributes is absent', () => {
    const item: FabLibraryItem = {
      assetId: 'fab-z',
      title: 'URL fallback',
      url: 'https://www.fab.com/listings/url-derived-id'
    }
    const row = normalizeFabAsset(item, 0)
    expect(row.productUrl).toBe('https://www.fab.com/listings/url-derived-id')
  })

  it('derives fabListingUid and engineVersions', () => {
    const row = normalizeFabAsset(
      {
        assetId: 'fab-e',
        title: 'Engines',
        customAttributes: [{ ListingIdentifier: 'lid-1' }],
        projectVersions: [
          { artifactId: 'a', engineVersions: ['UE_5.3'] },
          { artifactId: 'b', engineVersions: ['UE_5.4', 'UE_5.3'] }
        ]
      },
      0
    )
    expect(row.fabListingUid).toBe('lid-1')
    expect(row.engineVersions).toEqual(['5.4', '5.3'])
    expect(row.productUrl).toBe('https://www.fab.com/listings/lid-1')
  })

  it('falls back to the url tail for fabListingUid', () => {
    const row = normalizeFabAsset(
      { assetId: 'fab-u', title: 'U', url: 'https://www.fab.com/listings/from-url' },
      0
    )
    expect(row.fabListingUid).toBe('from-url')
    expect(row.engineVersions).toEqual([])
  })
})

describe('normalizeFabEntitlement', () => {
  it('maps createdAt, lastUpdatedAt and license slugs keyed by listing uid', () => {
    const n = normalizeFabEntitlement({
      uid: 'entitlement-id',
      createdAt: '2026-06-02T14:57:08.745696+00:00',
      entitlement: {
        licenses: [{ slug: 'professional' }, { slug: 'personal' }, { slug: 'personal' }, {}]
      },
      listing: { uid: 'listing-1', lastUpdatedAt: '2025-09-27T22:45:43.097204+00:00' }
    })
    expect(n).toEqual({
      listingUid: 'listing-1',
      info: {
        ownedAt: Date.UTC(2026, 5, 2, 14, 57, 8, 745),
        lastUpdatedAt: Date.UTC(2025, 8, 27, 22, 45, 43, 97),
        licenses: ['personal', 'professional']
      }
    })
  })

  it('returns null without a listing uid and tolerates missing fields', () => {
    expect(normalizeFabEntitlement({ uid: 'x' })).toBeNull()
    expect(normalizeFabEntitlement({ listing: { uid: 'l' } })).toEqual({
      listingUid: 'l',
      info: { ownedAt: null, lastUpdatedAt: null, licenses: [] }
    })
  })
})
