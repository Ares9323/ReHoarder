// Pulls the markdown block for a given version out of CHANGELOG.md and
// writes it to release-notes.md (gitignored). Consumed by both the
// `vpk pack --releaseNotes …` step (embeds notes into the .nupkg, so the
// in-app UpdateManager can show them) and `gh release edit --notes-file …`
// (renders them on the GitHub Release page).
//
// Section format expected:
//
//   ## [0.1.0] — 2026-05-14
//   <freeform markdown>
//   ## [0.1.1] — 2026-...
//
// The next `## ` heading (or EOF) terminates the section.

const fs = require('node:fs')
const path = require('node:path')

function readVersion() {
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf-8'))
  return String(pkg.version || '').replace(/^v/, '')
}

function extract(changelog, version) {
  const lines = changelog.split(/\r?\n/)
  // Match `## [0.1.0]` and the optional ` — date` suffix.
  const headRegex = new RegExp(`^## \\[${version.replace(/[.+]/g, '\\$&')}\\](?:\\s|$)`)
  let start = -1
  for (let i = 0; i < lines.length; i++) {
    if (headRegex.test(lines[i])) {
      start = i
      break
    }
  }
  if (start === -1) return null
  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    if (/^## /.test(lines[i])) {
      end = i
      break
    }
  }
  // Strip trailing blank lines + the link-reference block at the very end if
  // present, so the notes embedded in the nupkg don't carry "[0.1.0]: https…"
  // boilerplate.
  const block = lines.slice(start, end).join('\n').replace(/\s+$/, '')
  return block + '\n'
}

function main() {
  const version = readVersion()
  if (!version) {
    console.error('[release-notes] package.json version is empty.')
    process.exit(1)
  }
  const changelogPath = 'CHANGELOG.md'
  if (!fs.existsSync(changelogPath)) {
    console.error(`[release-notes] ${changelogPath} not found.`)
    process.exit(1)
  }
  const changelog = fs.readFileSync(changelogPath, 'utf-8')
  const block = extract(changelog, version)
  if (!block) {
    console.error(`[release-notes] no section for version ${version} in ${changelogPath}.`)
    process.exit(1)
  }
  const outPath = path.resolve('release-notes.md')
  fs.writeFileSync(outPath, block, 'utf-8')
  console.log(`[release-notes] wrote ${block.length} chars → ${outPath}`)
}

main()
