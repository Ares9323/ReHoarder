// Tiny pub/sub for "settings were just saved" — bumped by SettingsView after
// a successful `settings:set`, observed by views that scan filesystem paths
// derived from settings (Projects, Engines, …) so they reload without a
// restart. Singleton module-level $state, so every importer reads/observes
// the same counter.

let version = $state(0)

/** Reactive counter — read it inside an `$effect` to subscribe. */
export function settingsVersion(): number {
  return version
}

/** Increment the counter; observers re-run. */
export function bumpSettingsVersion(): void {
  version++
}
