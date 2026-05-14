// Upload the contents of ./Releases (produced by package-velopack.cjs) to a
// GitHub Release using vpk's built-in `upload github` command. The release
// tag and name are derived from package.json `version`. Requires:
//   - GITHUB_TOKEN env var (scope: `repo` for public, `repo` for private)
//   - `vpk` on PATH (see package-velopack.cjs comments)
//   - `./Releases/` to exist (run `npm run build:win` first)

const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const REPO_URL = 'https://github.com/Ares9323/ReHoarder'

function readVersion() {
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf-8'))
  return String(pkg.version || '').replace(/^v/, '')
}

function main() {
  const token = process.env.GITHUB_TOKEN
  if (!token) {
    console.error('[velopack] GITHUB_TOKEN is not set in the environment — aborting.')
    process.exit(1)
  }

  const releasesDir = path.resolve('Releases')
  if (!fs.existsSync(releasesDir)) {
    console.error('[velopack] ./Releases/ not found — run `npm run build:win` first.')
    process.exit(1)
  }

  const version = readVersion()
  const tag = `v${version}`

  const args = [
    'upload', 'github',
    '--repoUrl', REPO_URL,
    '--token', token,
    '--tag', tag,
    '--releaseName', `ReHoarder ${tag}`,
    '--publish'
  ]
  console.log(`> vpk ${args.map((a) => (a === token ? '****' : a)).join(' ')}`)
  const r = spawnSync('vpk', args, { stdio: 'inherit', shell: true })
  if (r.status !== 0) {
    console.error(`[velopack] vpk upload failed (exit ${r.status}).`)
    process.exit(r.status || 1)
  }
}

main()
