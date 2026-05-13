import { describe, it, expect } from 'vitest'
import { vi } from 'vitest'
import { extractCloudDirBase, fetchManifestLocator } from './manifest-client'
import { ManifestClientError } from './manifest-client-types'

describe('extractCloudDirBase', () => {
  it('returns everything up to and including "CloudDir/" from a manifest URL', () => {
    const url = 'https://download.epicgames.com/Builds/MyAsset/CloudDir/abc123.manifest'
    expect(extractCloudDirBase(url)).toBe(
      'https://download.epicgames.com/Builds/MyAsset/CloudDir/'
    )
  })

  it('returns the base even when query string is present', () => {
    const url =
      'https://cdn.example.com/foo/CloudDir/bar.manifest?sig=abc&exp=42'
    expect(extractCloudDirBase(url)).toBe('https://cdn.example.com/foo/CloudDir/')
  })

  it('throws ManifestClientError with code "clouddir-not-in-url" when CloudDir is missing', () => {
    const url = 'https://example.com/no-segment-here/file.manifest'
    expect(() => extractCloudDirBase(url)).toThrow(ManifestClientError)
    expect(() => extractCloudDirBase(url)).toThrow(/clouddir/i)
  })
})

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  })
}

describe('fetchManifestLocator', () => {
  it('POSTs to /e/artifacts/{artifactId}/manifest with form-urlencoded body and bearer header', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        downloadInfo: [
          {
            artifactId: 'MyAsset/build-1',
            manifestHash: 'AABBCC'.padEnd(40, 'D'),
            distributionPoints: [{ manifestUrl: 'https://cdn/x/CloudDir/y.manifest' }]
          }
        ]
      })
    )

    const locator = await fetchManifestLocator(
      fetchMock as unknown as typeof fetch,
      {
        artifactId: 'MyAsset/build-1',
        itemId: 'item-uuid-1',
        namespace: 'ns-uuid-1',
        platform: 'Windows',
        accessToken: 'the-bearer'
      }
    )

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://www.fab.com/e/artifacts/MyAsset/build-1/manifest')
    expect(init.method).toBe('POST')
    expect(init.headers['Authorization']).toBe('bearer the-bearer')
    expect(init.headers['content-type']).toBe('application/x-www-form-urlencoded')
    expect(init.body).toBe('item_id=item-uuid-1&namespace=ns-uuid-1&platform=Windows')
    expect(locator.artifactId).toBe('MyAsset/build-1')
    expect(locator.manifestHash).toBe('AABBCC'.padEnd(40, 'D'))
    expect(locator.distributionPoints).toHaveLength(1)
    expect(locator.distributionPoints[0].url).toBe('https://cdn/x/CloudDir/y.manifest')
  })

  it('normalizes the alternate shape uri+queryParams into a single URL with ?query', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        downloadInfo: [
          {
            artifactId: 'a',
            manifestHash: '0'.repeat(40),
            distributionPoints: [
              {
                uri: 'https://cdn/x/CloudDir/y.manifest',
                queryParams: [
                  { name: 'sig', value: 'abc' },
                  { name: 'exp', value: '42' }
                ]
              }
            ]
          }
        ]
      })
    )

    const locator = await fetchManifestLocator(
      fetchMock as unknown as typeof fetch,
      { artifactId: 'a', itemId: 'i', namespace: 'n', platform: 'Windows', accessToken: 't' }
    )
    expect(locator.distributionPoints[0].url).toBe(
      'https://cdn/x/CloudDir/y.manifest?sig=abc&exp=42'
    )
  })

  it('URL-encodes itemId / namespace correctly', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        downloadInfo: [
          {
            artifactId: 'a',
            manifestHash: '0'.repeat(40),
            distributionPoints: [{ manifestUrl: 'https://cdn/CloudDir/x.manifest' }]
          }
        ]
      })
    )

    await fetchManifestLocator(fetchMock as unknown as typeof fetch, {
      artifactId: 'a',
      itemId: 'has space/and+plus',
      namespace: 'foo&bar=baz',
      platform: 'Windows',
      accessToken: 't'
    })

    const body = fetchMock.mock.calls[0][1].body as string
    expect(body).toBe(
      'item_id=has+space%2Fand%2Bplus&namespace=foo%26bar%3Dbaz&platform=Windows'
    )
  })

  it('falls back from Mac to Windows when the Mac POST returns non-2xx', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ error: 'not found' }, 404))
      .mockResolvedValueOnce(
        jsonResponse({
          downloadInfo: [
            {
              artifactId: 'a',
              manifestHash: '0'.repeat(40),
              distributionPoints: [{ manifestUrl: 'https://cdn/CloudDir/x.manifest' }]
            }
          ]
        })
      )

    const locator = await fetchManifestLocator(fetchMock as unknown as typeof fetch, {
      artifactId: 'a',
      itemId: 'i',
      namespace: 'n',
      platform: 'Mac',
      accessToken: 't'
    })

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect((fetchMock.mock.calls[0][1].body as string).endsWith('platform=Mac')).toBe(true)
    expect((fetchMock.mock.calls[1][1].body as string).endsWith('platform=Windows')).toBe(true)
    expect(locator.artifactId).toBe('a')
  })

  it('throws "fab-non-2xx" when Windows also fails (no further fallback)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({}, 503))

    await expect(
      fetchManifestLocator(fetchMock as unknown as typeof fetch, {
        artifactId: 'a',
        itemId: 'i',
        namespace: 'n',
        platform: 'Windows',
        accessToken: 't'
      })
    ).rejects.toMatchObject({ name: 'ManifestClientError', code: 'fab-non-2xx' })
  })

  it('throws "fab-bad-json" when the body cannot be parsed', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response('not json', { status: 200 }))

    await expect(
      fetchManifestLocator(fetchMock as unknown as typeof fetch, {
        artifactId: 'a',
        itemId: 'i',
        namespace: 'n',
        platform: 'Windows',
        accessToken: 't'
      })
    ).rejects.toMatchObject({ name: 'ManifestClientError', code: 'fab-bad-json' })
  })

  it('throws "fab-no-distribution-points" when downloadInfo is missing or empty', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ downloadInfo: [] }))
    await expect(
      fetchManifestLocator(fetchMock as unknown as typeof fetch, {
        artifactId: 'a',
        itemId: 'i',
        namespace: 'n',
        platform: 'Windows',
        accessToken: 't'
      })
    ).rejects.toMatchObject({ code: 'fab-no-distribution-points' })
  })
})

import { createHash } from 'node:crypto'
import { downloadManifestBlob } from './manifest-client'

function bytesResponse(buf: Buffer, status = 200): Response {
  return new Response(buf, { status })
}
function sha1Upper(buf: Buffer): string {
  return createHash('sha1').update(buf).digest('hex').toUpperCase()
}

describe('downloadManifestBlob', () => {
  it('downloads the blob from the first distribution point whose SHA1 matches', async () => {
    const blob = Buffer.from('hello manifest bytes')
    const expected = sha1Upper(blob)
    const fetchMock = vi.fn().mockResolvedValue(bytesResponse(blob))

    const result = await downloadManifestBlob(fetchMock as unknown as typeof fetch, {
      artifactId: 'a',
      manifestHash: expected,
      distributionPoints: [{ url: 'https://cdn1/CloudDir/x.manifest' }]
    })

    expect(result.equals(blob)).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][0]).toBe('https://cdn1/CloudDir/x.manifest')
  })

  it('falls through to the next distribution point when the first returns wrong hash', async () => {
    const goodBlob = Buffer.from('correct blob')
    const goodSha = sha1Upper(goodBlob)
    const badBlob = Buffer.from('corrupt')
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(bytesResponse(badBlob))
      .mockResolvedValueOnce(bytesResponse(goodBlob))

    const result = await downloadManifestBlob(fetchMock as unknown as typeof fetch, {
      artifactId: 'a',
      manifestHash: goodSha,
      distributionPoints: [
        { url: 'https://cdn1/CloudDir/x.manifest' },
        { url: 'https://cdn2/CloudDir/x.manifest' }
      ]
    })

    expect(result.equals(goodBlob)).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('tolerates a distribution point that returns non-2xx and tries the next', async () => {
    const blob = Buffer.from('hi')
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('', { status: 503 }))
      .mockResolvedValueOnce(bytesResponse(blob))

    const result = await downloadManifestBlob(fetchMock as unknown as typeof fetch, {
      artifactId: 'a',
      manifestHash: sha1Upper(blob),
      distributionPoints: [
        { url: 'https://broken/CloudDir/x.manifest' },
        { url: 'https://ok/CloudDir/x.manifest' }
      ]
    })

    expect(result.equals(blob)).toBe(true)
  })

  it('throws "cdn-all-failed" when every distribution point fails or mismatches', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(bytesResponse(Buffer.from('a')))
      .mockResolvedValueOnce(bytesResponse(Buffer.from('b')))

    await expect(
      downloadManifestBlob(fetchMock as unknown as typeof fetch, {
        artifactId: 'a',
        manifestHash: 'F'.repeat(40),
        distributionPoints: [
          { url: 'https://cdn1/CloudDir/x.manifest' },
          { url: 'https://cdn2/CloudDir/x.manifest' }
        ]
      })
    ).rejects.toMatchObject({ name: 'ManifestClientError', code: 'cdn-all-failed' })
  })

  it('tolerates a distribution point whose fetch throws and tries the next', async () => {
    const blob = Buffer.from('hi')
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error('ENOTFOUND'))
      .mockResolvedValueOnce(bytesResponse(blob))

    const result = await downloadManifestBlob(fetchMock as unknown as typeof fetch, {
      artifactId: 'a',
      manifestHash: sha1Upper(blob),
      distributionPoints: [
        { url: 'https://broken/CloudDir/x.manifest' },
        { url: 'https://ok/CloudDir/x.manifest' }
      ]
    })

    expect(result.equals(blob)).toBe(true)
  })
})

import { deflateSync } from 'node:zlib'
import { requestManifest } from './manifest-client'
import { MANIFEST_MAGIC } from './parse-manifest-header'
import {
  bytes,
  fstring,
  guidHex,
  int32le,
  int64le,
  int8,
  sha1Hex,
  uint32le,
  uint64le,
  uint8
} from './test-fixtures'

function buildMinimalManifestBlob(): Buffer {
  // Reuses the same fixture pattern as manifest-parser.test.ts.
  const guid1 = '00000000000000000000000000000001'
  const metaBody = bytes(
    uint8(2),
    uint32le(18),
    uint8(0),
    uint32le(42),
    fstring('TestAsset'),
    fstring('1.0.0'),
    fstring(''),
    fstring(''),
    int32le(0),
    fstring(''),
    fstring(''),
    fstring(''),
    fstring('build-id'),
    fstring(''),
    fstring('')
  )
  const meta = bytes(uint32le(4 + metaBody.length), metaBody)
  const chunkBody = bytes(
    uint8(1),
    int32le(1),
    guidHex(guid1),
    uint64le(0xdeadbeefcafef00dn),
    sha1Hex('AA'.repeat(20)),
    int8(3),
    int32le(1024),
    int64le(500n)
  )
  const chunks = bytes(uint32le(4 + chunkBody.length), chunkBody)
  const chunkPart = bytes(
    uint32le(4 + 16 + 4 + 4),
    guidHex(guid1),
    uint32le(0),
    uint32le(50)
  )
  const filesBody = bytes(
    uint8(0),
    int32le(1),
    fstring('Content/Foo.uasset'),
    fstring(''),
    sha1Hex('BB'.repeat(20)),
    uint8(0),
    int32le(0),
    int32le(1),
    chunkPart
  )
  const files = bytes(uint32le(4 + filesBody.length), filesBody)
  const customBody = bytes(uint8(0), int32le(0))
  const custom = bytes(uint32le(4 + customBody.length), customBody)
  const data = Buffer.concat([meta, chunks, files, custom])
  const compressed = deflateSync(data)
  const sha = createHash('sha1').update(data).digest()
  const header = bytes(
    uint32le(MANIFEST_MAGIC),
    uint32le(41),
    uint32le(data.length),
    uint32le(compressed.length),
    sha,
    uint8(0x01),
    uint32le(18)
  )
  return Buffer.concat([header, compressed])
}

describe('requestManifest (integration)', () => {
  it('end-to-end: Fab POST → CDN GET → parse → ManifestBundle', async () => {
    const blob = buildMinimalManifestBlob()
    const expectedSha = sha1Upper(blob)
    const fetchMock = vi
      .fn()
      // First call: Fab POST → JSON locator.
      .mockResolvedValueOnce(
        jsonResponse({
          downloadInfo: [
            {
              artifactId: 'MyAsset/build-1',
              manifestHash: expectedSha,
              distributionPoints: [
                { manifestUrl: 'https://cdn.example/foo/CloudDir/abc.manifest' }
              ]
            }
          ]
        })
      )
      // Second call: CDN GET → blob.
      .mockResolvedValueOnce(bytesResponse(blob))

    const bundle = await requestManifest(fetchMock as unknown as typeof fetch, {
      artifactId: 'MyAsset/build-1',
      itemId: 'item-uuid-1',
      namespace: 'ns-uuid-1',
      platform: 'Windows',
      accessToken: 'the-bearer'
    })

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(bundle.manifest.meta.appName).toBe('TestAsset')
    expect(bundle.manifest.chunks).toHaveLength(1)
    expect(bundle.manifest.files[0].filename).toBe('Content/Foo.uasset')
    expect(bundle.baseUris).toEqual(['https://cdn.example/foo/CloudDir/'])
    expect(bundle.locator.artifactId).toBe('MyAsset/build-1')
  })

  it('returns one baseUri per distributionPoint, in order', async () => {
    const blob = buildMinimalManifestBlob()
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          downloadInfo: [
            {
              artifactId: 'a',
              manifestHash: sha1Upper(blob),
              distributionPoints: [
                { manifestUrl: 'https://cdn1/foo/CloudDir/x.manifest' },
                { manifestUrl: 'https://cdn2/bar/CloudDir/y.manifest' }
              ]
            }
          ]
        })
      )
      .mockResolvedValueOnce(bytesResponse(blob))

    const bundle = await requestManifest(fetchMock as unknown as typeof fetch, {
      artifactId: 'a',
      itemId: 'i',
      namespace: 'n',
      platform: 'Windows',
      accessToken: 't'
    })

    expect(bundle.baseUris).toEqual([
      'https://cdn1/foo/CloudDir/',
      'https://cdn2/bar/CloudDir/'
    ])
  })
})
