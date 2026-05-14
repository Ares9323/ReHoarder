#!/usr/bin/env node
/**
 * Rasterise `resources/icon.svg` into the two artefacts electron-builder /
 * Velopack expect under `resources/`:
 *
 *   - `icon.png` — 256×256, used for Linux (.AppImage / .deb) and the macOS
 *     `.icns` source.
 *   - `icon.ico` — Windows multi-resolution bundle (16, 32, 48, 64, 128, 256).
 *
 * The SVG is the single source of truth; both PNG and ICO are regenerated
 * deterministically. Run `npm run build:icons` after editing the SVG.
 */
'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { Resvg } = require('@resvg/resvg-js')
const pngToIco = require('png-to-ico').default

const ROOT = path.resolve(__dirname, '..')
const SVG_PATH = path.join(ROOT, 'resources', 'icon.svg')
const PNG_PATH = path.join(ROOT, 'resources', 'icon.png')
const ICO_PATH = path.join(ROOT, 'resources', 'icon.ico')

const ICO_SIZES = [16, 32, 48, 64, 128, 256]

function rasterise(svg, size) {
  const resvg = new Resvg(svg, {
    fitTo: { mode: 'width', value: size },
    background: 'rgba(0,0,0,0)'
  })
  return resvg.render().asPng()
}

async function main() {
  if (!fs.existsSync(SVG_PATH)) {
    console.error(`[icons] missing source: ${SVG_PATH}`)
    process.exit(1)
  }
  const svg = fs.readFileSync(SVG_PATH)

  // Linux/Mac PNG — 256×256 is what electron-builder consumes.
  fs.writeFileSync(PNG_PATH, rasterise(svg, 256))
  console.log(`[icons] wrote ${path.relative(ROOT, PNG_PATH)} (256×256)`)

  // Windows ICO — bundle every size png-to-ico needs into one .ico file.
  const pngBuffers = ICO_SIZES.map((s) => rasterise(svg, s))
  const ico = await pngToIco(pngBuffers)
  fs.writeFileSync(ICO_PATH, ico)
  console.log(
    `[icons] wrote ${path.relative(ROOT, ICO_PATH)} (${ICO_SIZES.join(', ')})`
  )
}

main().catch((err) => {
  console.error('[icons] failed:', err)
  process.exit(1)
})
