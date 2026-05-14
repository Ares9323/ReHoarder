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
const os = require('node:os')
const path = require('node:path')

const PRODUCT_NAME = 'ReHoarder'
const PRODUCT_VERSION = '0.1.1-dev'
const FILE_DESCRIPTION = 'ReHoarder'
const COMPANY_NAME = 'Ares9323'
// Bumped when the icon source changes so the marker invalidates and rcedit
// re-stamps electron.exe on the next `npm run dev`.
const ICON_REV = 1

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
  const expectedStamp = `${PRODUCT_NAME}@${PRODUCT_VERSION}+icon${ICON_REV}`
  if (fs.existsSync(markerPath)) {
    const stamp = fs.readFileSync(markerPath, 'utf-8').trim()
    if (stamp === expectedStamp) {
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

  const iconPath = path.join(__dirname, '..', 'resources', 'icon.ico')
  const opts = {
    'product-name': PRODUCT_NAME,
    'product-version': PRODUCT_VERSION,
    'file-description': FILE_DESCRIPTION,
    'company-name': COMPANY_NAME
  }
  if (fs.existsSync(iconPath)) {
    opts.icon = iconPath
  } else {
    console.warn(`[brand-dev-electron] icon not found at ${iconPath} — taskbar will keep the default Electron atom`)
  }

  // Defender real-time protection sometimes refuses in-place edits under
  // node_modules with "Unable to commit changes". If that happens, stamp a
  // temp copy and move it back — both ops are 200 MB-ish but reliable.
  try {
    await rcedit(exePath, opts)
    fs.writeFileSync(markerPath, `${expectedStamp}\n`)
    console.warn(`[brand-dev-electron] rebranded ${exePath} → ${PRODUCT_NAME}`)
    return
  } catch (err) {
    const msg = err && err.message ? err.message : String(err)
    if (!/Unable to commit changes/i.test(msg)) {
      console.warn(`[brand-dev-electron] rcedit failed: ${msg}`)
      return
    }
    console.warn(`[brand-dev-electron] direct rcedit refused (likely AV lock) — retrying via temp copy`)
  }

  const tempPath = path.join(os.tmpdir(), `electron-${process.pid}-stamp.exe`)
  try {
    fs.copyFileSync(exePath, tempPath)
    await rcedit(tempPath, opts)
    fs.copyFileSync(tempPath, exePath)
    fs.writeFileSync(markerPath, `${expectedStamp}\n`)
    console.warn(`[brand-dev-electron] rebranded ${exePath} → ${PRODUCT_NAME} (via temp)`)
  } catch (err) {
    console.warn(`[brand-dev-electron] temp-copy rcedit also failed: ${err && err.message ? err.message : err}`)
  } finally {
    try {
      fs.unlinkSync(tempPath)
    } catch {
      /* ignore */
    }
  }
}

main()
