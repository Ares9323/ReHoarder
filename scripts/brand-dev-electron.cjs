// Rebrand the local `node_modules/electron/dist/electron.exe` so it shows up
// as "ReHoarder" in Windows' Task Manager when running `npm run dev`. In a
// packaged build electron-builder already does this for us — this script
// fills the gap for the dev binary, which is what Windows users see day to
// day during development.
//
// Idempotent: we stamp the path with a stable marker the first time we
// rebrand it, so subsequent runs are a no-op even after `npm install`
// replaces the binary (the marker file lives next to the exe). On non-
// Windows platforms this is a no-op.

const fs = require('node:fs')
const path = require('node:path')

const PRODUCT_NAME = 'ReHoarder'
const PRODUCT_VERSION = '0.1.0-dev'
const FILE_DESCRIPTION = 'ReHoarder'
const COMPANY_NAME = 'Ares9323'

async function main() {
  if (process.platform !== 'win32') {
    return
  }

  const electronDir = path.join(__dirname, '..', 'node_modules', 'electron', 'dist')
  const exePath = path.join(electronDir, 'electron.exe')
  const markerPath = path.join(electronDir, '.rehoarder-branded')

  if (!fs.existsSync(exePath)) {
    console.warn(`[brand-dev-electron] electron.exe not found at ${exePath} — skipping`)
    return
  }
  if (fs.existsSync(markerPath)) {
    const stamp = fs.readFileSync(markerPath, 'utf-8').trim()
    if (stamp === `${PRODUCT_NAME}@${PRODUCT_VERSION}`) {
      return
    }
  }

  let rcedit
  try {
    rcedit = require('rcedit')
  } catch (err) {
    console.warn(`[brand-dev-electron] rcedit not installed — run \`npm install\` to enable Task Manager rebranding`)
    return
  }

  try {
    await rcedit(exePath, {
      'product-name': PRODUCT_NAME,
      'product-version': PRODUCT_VERSION,
      'file-description': FILE_DESCRIPTION,
      'company-name': COMPANY_NAME
    })
    fs.writeFileSync(markerPath, `${PRODUCT_NAME}@${PRODUCT_VERSION}\n`)
    console.warn(`[brand-dev-electron] rebranded ${exePath} → ${PRODUCT_NAME}`)
  } catch (err) {
    console.warn(`[brand-dev-electron] rcedit failed: ${err && err.message ? err.message : err}`)
  }
}

main()
