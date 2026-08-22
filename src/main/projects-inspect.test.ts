import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fsp } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { inspectProjectFolder } from './projects-inspect'

let tmp: string
beforeEach(async () => {
  tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'rehoarder-inspect-'))
})
afterEach(async () => {
  await fsp.rm(tmp, { recursive: true, force: true })
})

describe('inspectProjectFolder', () => {
  it('finds a .uproject and reads its EngineAssociation', async () => {
    const dir = path.join(tmp, 'MyFolder')
    await fsp.mkdir(dir, { recursive: true })
    await fsp.writeFile(
      path.join(dir, 'My.uproject'),
      JSON.stringify({ EngineAssociation: '5.4' })
    )

    const r = await inspectProjectFolder(dir)
    expect(r.ok).toBe(true)
    expect(r.project).not.toBeNull()
    expect(r.project?.name).toBe('My')
    expect(r.project?.uprojectPath).toBe(path.join(dir, 'My.uproject'))
    expect(r.project?.projectDir).toBe(path.resolve(dir))
    expect(r.project?.engineAssociation).toBe('5.4')
  })

  it('returns project: null when the folder has no .uproject', async () => {
    const dir = path.join(tmp, 'Empty')
    await fsp.mkdir(dir, { recursive: true })
    await fsp.writeFile(path.join(dir, 'note.txt'), 'hi')

    const r = await inspectProjectFolder(dir)
    expect(r.ok).toBe(true)
    expect(r.project).toBeNull()
  })

  it('returns engineAssociation "" when the field is missing', async () => {
    const dir = path.join(tmp, 'NoAssoc')
    await fsp.mkdir(dir, { recursive: true })
    await fsp.writeFile(path.join(dir, 'Proj.uproject'), JSON.stringify({}))

    const r = await inspectProjectFolder(dir)
    expect(r.ok).toBe(true)
    expect(r.project?.engineAssociation).toBe('')
  })

  it('does not throw and returns ok:false for a nonexistent directory', async () => {
    const r = await inspectProjectFolder(path.join(tmp, 'does-not-exist'))
    expect(r.ok).toBe(false)
    expect(r.error).toBeTruthy()
  })

  it('picks only the first .uproject among immediate children, ignoring subfolders', async () => {
    const dir = path.join(tmp, 'Multi')
    await fsp.mkdir(path.join(dir, 'Sub'), { recursive: true })
    await fsp.writeFile(path.join(dir, 'Real.uproject'), JSON.stringify({ EngineAssociation: '5.6' }))
    await fsp.writeFile(path.join(dir, 'Sub', 'Nested.uproject'), JSON.stringify({ EngineAssociation: '5.0' }))

    const r = await inspectProjectFolder(dir)
    expect(r.ok).toBe(true)
    expect(r.project?.name).toBe('Real')
  })
})
