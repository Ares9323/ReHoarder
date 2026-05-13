import type { BinaryReader } from './binary-reader'
import type { ManifestMeta } from './manifest-types'

const VERSION_HAS_BUILD_ID = 1
const VERSION_HAS_UNINSTALL = 2

export function parseManifestMeta(r: BinaryReader): ManifestMeta {
  const start = r.position
  const sectionSize = r.readUInt32LE()
  const sectionVersion = r.readUInt8()
  const featureLevel = r.readUInt32LE()
  const bIsFileData = r.readUInt8() !== 0
  const appId = r.readUInt32LE()
  const appName = r.readFString()
  const buildVersion = r.readFString()
  const launchExe = r.readFString()
  const launchCommand = r.readFString()
  const prereqCount = r.readInt32LE()
  const prereqIds: string[] = []
  for (let i = 0; i < prereqCount; i++) prereqIds.push(r.readFString())
  const prereqName = r.readFString()
  const prereqPath = r.readFString()
  const prereqArgs = r.readFString()
  const buildId = sectionVersion >= VERSION_HAS_BUILD_ID ? r.readFString() : ''
  let uninstallExe = ''
  let uninstallCommand = ''
  if (sectionVersion >= VERSION_HAS_UNINSTALL) {
    uninstallExe = r.readFString()
    uninstallCommand = r.readFString()
  }
  // Seek past any remaining bytes within the declared sectionSize.
  r.seek(start + sectionSize)
  return {
    featureLevel,
    bIsFileData,
    appId,
    appName,
    buildVersion,
    buildId,
    launchExe,
    launchCommand,
    prereqIds,
    prereqName,
    prereqPath,
    prereqArgs,
    uninstallExe,
    uninstallCommand
  }
}
