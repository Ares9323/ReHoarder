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

// Wrap args containing whitespace in double quotes before joining the
// command line. Required when invoking with `shell: true` on Windows —
// otherwise `--releaseName "ReHoarder v0.1.0"` is split by cmd.exe into
// `--releaseName ReHoarder` + `v0.1.0` and vpk errors out with
// "Unrecognized command or argument".
function quoteArg(s) {
  return /[\s"']/.test(s) ? '"' + String(s).replace(/"/g, '\\"') + '"' : String(s)
}

function runShell(cmd, args, env) {
  const line = [cmd, ...args.map(quoteArg)].join(' ')
  console.log(`> ${line.replace(env && env.TOKEN ? env.TOKEN : '__NO_TOKEN__', '****')}`)
  return spawnSync(line, { stdio: 'inherit', shell: true, env: env ?? process.env })
}

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

  const vpkArgs = [
    'upload', 'github',
    '--repoUrl', REPO_URL,
    '--token', token,
    '--tag', tag,
    '--releaseName', `ReHoarder ${tag}`,
    '--publish'
  ]
  const r = runShell('vpk', vpkArgs, { ...process.env, TOKEN: token })
  if (r.status !== 0) {
    console.error(`[velopack] vpk upload failed (exit ${r.status}).`)
    process.exit(r.status || 1)
  }

  // vpk upload doesn't fill in the GitHub Release body — it only attaches
  // artefacts. We patch the description ourselves via `gh release edit` so
  // the page mirrors what we embedded in the nupkg.
  const notesPath = path.resolve('release-notes.md')
  if (fs.existsSync(notesPath)) {
    const gh = runShell('gh', ['release', 'edit', tag, '--notes-file', notesPath], {
      ...process.env,
      GH_TOKEN: token,
      TOKEN: token
    })
    if (gh.status !== 0) {
      console.warn(
        `[velopack] gh release edit failed (exit ${gh.status}). Release is up but body was not updated.`
      )
    }
  } else {
    console.warn('[velopack] release-notes.md not found — release body left empty.')
  }
}

main()
