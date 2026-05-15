/**
 * User-Agent string passed to Epic launcher / catalog / Fab endpoints.
 *
 * Mimics the Epic Games Launcher fingerprint. The asset-catalog listing
 * (`/launcher/api/public/assets/Windows?label=Live`) accepts any UA that
 * starts with `EpicGamesLauncher/`, but the engine download-info path
 * (`/launcher/api/public/assets/v2/.../label/Live`) enforces a richer
 * shape — sending a stub there returns HTTP 403 / `missing_permission`,
 * which looks like a scope revocation but is actually a UA gate.
 *
 * The value below mirrors the UA AMS 1.2.0 ships (cross-verified 2026-05-15
 * against the working live endpoint). If a future Epic change blocks this
 * value, lift a fresh one off a current Epic Games Launcher install.
 */
export const EPIC_USER_AGENT =
  'EpicGamesLauncher/14.2.3-22076013+++Portal+Release-Live Windows/10.0.22000.1.256.64bit'
