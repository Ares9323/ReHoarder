import { describe, it, expect } from 'vitest'
import {
  normalizeVaultAsset,
  normalizeFabAsset,
  normalizeFabOtherAsset,
  isUnrealEngineListing
} from './normalize'
import type { CatalogItem, VaultAssetSummary } from '../vault/vault-client'
import type { FabLibraryItem, FabOtherListing } from '../fab/fab-client'

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
})

describe('normalizeFabOtherAsset', () => {
  it('produces an AssetRow with uid as sourceId and a fab.com listing URL', () => {
    const listing: FabOtherListing = {
      uid: 'other-uid-123',
      title: 'My Blender Pack',
      assetFormats: [
        {
          assetFormatType: { code: 'blender', name: 'Blender' },
          technicalSpecs: { technicalDetails: 'High-poly mesh, 4K textures' }
        }
      ],
      thumbnails: [
        {
          mediaUrl: 'https://media/preview.mp4',
          images: [
            { url: 'https://img/small.png', width: 256 },
            { url: 'https://img/medium.png', width: 480 },
            { url: 'https://img/large.png', width: 1024 }
          ]
        }
      ]
    }

    const row = normalizeFabOtherAsset(listing, 1_700_000_000_000)

    expect(row).toMatchObject({
      source: 'fab',
      sourceId: 'other-uid-123',
      title: 'My Blender Pack',
      description: 'High-poly mesh, 4K textures',
      // Largest image whose width < 500
      imageUrl: 'https://img/medium.png',
      productUrl: 'https://www.fab.com/listings/other-uid-123',
      ownedAt: null,
      hidden: false,
      syncedAt: 1_700_000_000_000
    })
  })

  it('handles listings without thumbnails or assetFormats gracefully', () => {
    const listing: FabOtherListing = { uid: 'bare', title: 'Bare' }
    const row = normalizeFabOtherAsset(listing, 0)
    expect(row.imageUrl).toBeNull()
    expect(row.description).toBeNull()
    expect(row.productUrl).toBe('https://www.fab.com/listings/bare')
  })

  it('falls back to the first image when no thumbnail is under 500px', () => {
    const listing: FabOtherListing = {
      uid: 'huge-only',
      title: 'Only Huge Images',
      thumbnails: [
        {
          images: [
            { url: 'https://img/huge1.png', width: 2048 },
            { url: 'https://img/huge2.png', width: 1024 }
          ]
        }
      ]
    }
    const row = normalizeFabOtherAsset(listing, 0)
    expect(row.imageUrl).toBe('https://img/huge1.png')
  })
})

describe('isUnrealEngineListing', () => {
  it('returns true when any assetFormat code is "unreal-engine"', () => {
    expect(
      isUnrealEngineListing({
        uid: 'x',
        title: 'X',
        assetFormats: [
          { assetFormatType: { code: 'blender', name: 'Blender' } },
          { assetFormatType: { code: 'unreal-engine', name: 'Unreal Engine' } }
        ]
      })
    ).toBe(true)
  })

  it('returns false when no assetFormat is unreal-engine', () => {
    expect(
      isUnrealEngineListing({
        uid: 'x',
        title: 'X',
        assetFormats: [{ assetFormatType: { code: 'maya', name: 'Maya' } }]
      })
    ).toBe(false)
  })

  it('returns false when assetFormats is absent', () => {
    expect(isUnrealEngineListing({ uid: 'x', title: 'X' })).toBe(false)
  })
})
