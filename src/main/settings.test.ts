import { mkdtempSync, mkdirSync, rmSync, existsSync, writeFileSync } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let userData = ''

vi.mock('electron', () => ({
  app: {
    getPath: (key: string) => (key === 'userData' ? userData : `/tmp/electron-${key}`)
  }
}))

import { defaultSettings, ensureVaultDirs } from './settings'

describe('vault paths', () => {
  let tmp = ''
  const realPlatform = process.platform
  const realProgramData = process.env.ProgramData

  beforeEach(() => {
    tmp = mkdtempSync(path.join(os.tmpdir(), 'rh-settings-'))
    userData = path.join(tmp, 'userData')
    mkdirSync(userData)
    Object.defineProperty(process, 'platform', { value: 'win32' })
    process.env.ProgramData = path.join(tmp, 'ProgramData')
  })

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: realPlatform })
    if (realProgramData === undefined) delete process.env.ProgramData
    else process.env.ProgramData = realProgramData
    rmSync(tmp, { recursive: true, force: true })
  })

  it("defaults to the Epic Games Launcher's VaultCache on Windows", () => {
    expect(defaultSettings().vaultPaths).toEqual([
      path.join(tmp, 'ProgramData', 'Epic', 'EpicGamesLauncher', 'VaultCache')
    ])
  })

  it('keeps the old debug-downloads folder listed when it exists', () => {
    mkdirSync(path.join(userData, 'debug-downloads'))
    expect(defaultSettings().vaultPaths).toEqual([
      path.join(tmp, 'ProgramData', 'Epic', 'EpicGamesLauncher', 'VaultCache'),
      path.join(userData, 'debug-downloads')
    ])
  })

  it('creates missing vault folders and skips the ones it cannot create', async () => {
    const nested = path.join(tmp, 'a', 'b', 'VaultCache')
    const blocker = path.join(tmp, 'file')
    writeFileSync(blocker, '')
    await expect(ensureVaultDirs([nested, path.join(blocker, 'sub')])).resolves.toBeUndefined()
    expect(existsSync(nested)).toBe(true)
  })
})
