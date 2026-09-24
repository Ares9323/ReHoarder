/**
 * Short form of a Fab `Manifest.meta.buildVersion`
 * (`5.7.0-48201490+++UE5+Dev-Marketplace-Windows` becomes `48201490`).
 * Unknown shapes are returned unchanged.
 */
export function shortBuildNumber(buildVersion: string): string {
  const m = buildVersion.match(/^[^-]*-(\d+)/)
  return m ? m[1] : buildVersion
}

/** Pill text for a Local Vault row, or null when neither version is known. */
export function vaultVersionLabel(
  engineVersion: string | null,
  buildVersion: string | null
): string | null {
  const parts: string[] = []
  if (engineVersion) parts.push(`UE ${engineVersion}`)
  if (buildVersion) parts.push(`build ${shortBuildNumber(buildVersion)}`)
  return parts.length > 0 ? parts.join(' · ') : null
}
