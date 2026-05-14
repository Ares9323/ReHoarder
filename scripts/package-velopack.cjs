// Two-stage packaging for Windows builds:
//   1. electron-builder produces an unpacked Electron app (no installer)
//      under release/win-unpacked/ — this gives us a real ReHoarder.exe
//      with bundled chrome.dll, ffmpeg, etc.
//   2. vpk (Velopack CLI) reads that directory and produces:
//        Releases/ReHoarder-Setup.exe   — first-run installer
//        Releases/ReHoarder-<v>-full.nupkg
//        Releases/ReHoarder-<v>-delta.nupkg  (from the 2nd release onwards)
//        Releases/RELEASES               — index consumed by UpdateManager
//
// vpk is a dotnet tool: `dotnet tool install -g vpk`. If it's not on PATH
// we abort with an actionable error rather than producing a half-built
// release directory.

const { execSync, spawnSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

// Velopack uses `packId` as both the app identifier *and* the filename prefix
// for the generated artefacts (Setup.exe, nupkg, Portable.zip). Keep it as the
// user-facing product name so the installer downloaded from GitHub is called
// `ReHoarder-win-Setup.exe`, not the reverse-domain `studio.rehoarder.app-…`.
// The Windows AppUserModelId stays `studio.rehoarder.app` via electron-builder.
const PACK_ID = 'ReHoarder'
const PACK_TITLE = 'ReHoarder'
const PACK_AUTHORS = 'Ares9323'
const MAIN_EXE = 'ReHoarder.exe'
const ICON = path.join('resources', 'icon.ico')

function readVersion() {
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf-8'))
  return String(pkg.version || '').replace(/^v/, '')
}

function ensureVpk() {
  const probe = spawnSync('vpk', ['--help'], { stdio: 'ignore', shell: true })
  if (probe.status !== 0) {
    console.error(
      '[velopack] `vpk` not found on PATH.\n' +
        '         Install it once with:\n' +
        '           dotnet tool install -g vpk\n' +
        '         (requires .NET SDK 8+: https://dot.net)'
    )
    process.exit(1)
  }
}

function run(cmd, args) {
  console.log(`> ${cmd} ${args.join(' ')}`)
  const r = spawnSync(cmd, args, { stdio: 'inherit', shell: true })
  if (r.status !== 0) {
    console.error(`[velopack] command failed: ${cmd} ${args.join(' ')} (exit ${r.status})`)
    process.exit(r.status || 1)
  }
}

async function main() {
  if (process.platform !== 'win32') {
    console.error('[velopack] Windows-only for now; Linux/macOS targets land later.')
    process.exit(1)
  }

  const version = readVersion()
  if (!version) {
    console.error('[velopack] package.json `version` is empty — refusing to pack.')
    process.exit(1)
  }
  ensureVpk()

  // Stage 1: electron-vite + electron-builder --dir for a clean unpacked app.
  run('npx', ['electron-vite', 'build'])
  run('npx', ['electron-builder', '--win', '--dir'])

  // electron-builder.yml's `directories.output: release/${version}` puts the
  // unpacked tree at release/<version>/win-unpacked, not release/win-unpacked.
  const unpackedDir = path.resolve('release', version, 'win-unpacked')
  if (!fs.existsSync(unpackedDir)) {
    console.error(`[velopack] expected ${unpackedDir} from electron-builder --dir; not found.`)
    process.exit(1)
  }

  // Belt-and-suspenders: electron-builder's Version Info population from
  // package.json `description` has been unreliable for us — Windows Task
  // Manager kept showing the long marketing string. Force-set FileDescription
  // + ProductName via rcedit so the per-process label is just "ReHoarder",
  // regardless of how electron-builder mapped the metadata.
  const rcedit = require('rcedit')
  const exePath = path.join(unpackedDir, MAIN_EXE)
  try {
    await rcedit(exePath, {
      'product-name': PACK_TITLE,
      'product-version': version,
      'file-description': PACK_TITLE,
      'company-name': PACK_AUTHORS
    })
    console.log(`[velopack] rebranded ${exePath} → FileDescription="${PACK_TITLE}"`)
  } catch (err) {
    console.warn(`[velopack] rcedit FileDescription patch failed: ${err && err.message ? err.message : err}`)
  }

  // Extract release notes for this version from CHANGELOG.md (writes
  // ./release-notes.md). Non-fatal if missing: vpk will just produce a
  // .nupkg without embedded notes.
  let releaseNotesPath = null
  const notesProbe = spawnSync(process.execPath, ['scripts/extract-release-notes.cjs'], {
    stdio: 'inherit'
  })
  if (notesProbe.status === 0 && fs.existsSync('release-notes.md')) {
    releaseNotesPath = path.resolve('release-notes.md')
  } else {
    console.warn('[velopack] no CHANGELOG entry for this version — packing without release notes.')
  }

  // Stage 2: vpk pack on the unpacked app.
  const vpkArgs = [
    'pack',
    '--packId', PACK_ID,
    '--packTitle', PACK_TITLE,
    '--packAuthors', PACK_AUTHORS,
    '--packVersion', version,
    '--packDir', unpackedDir,
    '--mainExe', MAIN_EXE
  ]
  if (fs.existsSync(ICON)) {
    vpkArgs.push('--icon', ICON)
  }
  if (releaseNotesPath) {
    vpkArgs.push('--releaseNotes', releaseNotesPath)
  }
  run('vpk', vpkArgs)

  console.log(`\n[velopack] Done. Artefacts in ./Releases/`)
}

main().catch((err) => {
  console.error('[velopack] unhandled error:', err)
  process.exit(1)
})
