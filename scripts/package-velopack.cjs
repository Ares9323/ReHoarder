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

const PACK_ID = 'studio.rehoarder.app'
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

function main() {
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

  const unpackedDir = path.resolve('release', 'win-unpacked')
  if (!fs.existsSync(unpackedDir)) {
    console.error(`[velopack] expected ${unpackedDir} from electron-builder --dir; not found.`)
    process.exit(1)
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
  run('vpk', vpkArgs)

  console.log(`\n[velopack] Done. Artefacts in ./Releases/`)
}

main()
