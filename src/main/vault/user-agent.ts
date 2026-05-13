/**
 * User-Agent string passed to Epic launcher / catalog / Fab endpoints.
 *
 * Mimics the Epic Games Launcher fingerprint. The real launcher sends
 * something like `EpicGamesLauncher/15.x.x-XXXXXXX+++Portal+Release-Live
 * Windows/10.0.x.x.x.x.x.x`.
 *
 * Empirically, the Epic public OAuth + catalog endpoints accept any UA that
 * starts with `EpicGamesLauncher/`. If a future Epic change blocks our value,
 * lift a real one off a fresh launcher build and pin it here.
 */
export const EPIC_USER_AGENT = 'EpicGamesLauncher/15.0.0-stub Windows/10.0'
