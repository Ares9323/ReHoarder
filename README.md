# ReHoarder

> **Reorder your hoard. Then re-hoard.**
> An open-source desktop manager for your ever-growing pile of Unreal Engine assets.

ReHoarder is a cross-platform companion app for Unreal Engine creators who can't stop claiming every "Free for the Month" on Fab, every Epic vault giveaway, and every legacy Marketplace bundle — and then have no idea what they actually own.

It connects to your Epic Games account, indexes everything you've ever acquired across **Fab**, the **Epic Vault**, and the legacy **Unreal Engine Marketplace**, and gives you a single searchable, taggable, filterable library to make sense of it all.

---

## What it does

- **One library, three sources** — unifies Fab, the Epic Vault (UE5+), and the legacy Unreal Engine Marketplace into a single view.
- **Bulk metadata sync** — pulls titles, descriptions, screenshots, categories, supported engine versions, and pricing history for everything you own.
- **Local catalog** — keeps an offline cache so you can browse your library without an internet connection or sign-in round-trips.
- **Auto-claim Fab freebies** *(planned)* — never miss a monthly free drop again.
- **Tagging and filtering** — organize by your own taxonomy: "used", "for current project", "wishlist", "never going to touch", etc.
- **Download manager** *(planned)* — fetches asset manifests and installs them into a chosen UE project or a shared library folder.
- **Duplicate / overlap detection** *(planned)* — flags assets you own multiple times across Humble Bundle, Fab, and the legacy Marketplace.

## Status

**Pre-alpha — under active design.** Nothing works yet. Star/watch the repo if you want to follow along.

## Why another asset manager?

ReHoarder aims to be:

- **Fully open source** (MIT) — readable, auditable, forkable.
- **Cross-platform first-class** — Linux, Windows, and macOS treated as equals from day one.
- **Privacy-respectful** — your account credentials and library data stay on your machine.

## Platforms

- Windows 10/11
- Linux (any modern distro)
- macOS *(planned)*

## Tech stack

- **Electron** + **TypeScript** for the desktop shell and OAuth-via-embedded-browser flow.
- **Svelte** *(tentative)* for the renderer UI.
- **SQLite** for the local library catalog.

## Disclaimer

ReHoarder is an unofficial third-party tool. It is **not affiliated with, endorsed by, or sponsored by Epic Games, Inc.** "Unreal Engine", "Fab", and "Epic Games" are trademarks of Epic Games, Inc. ReHoarder communicates with public Epic and Fab endpoints using the same conventions as the official Epic Games Launcher; you are responsible for ensuring your use complies with Epic's Terms of Service.

## License

[MIT](LICENSE) © 2026 Ares9323
