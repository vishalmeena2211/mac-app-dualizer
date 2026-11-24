# Changelog

All notable changes to this project are documented here.
Format loosely follows [Keep a Changelog](https://keepachangelog.com/).

## [Unreleased]

### Added
- **Distinct clone icons** — clones get an auto-colored badge (deterministic from
  the name, or `--tint "#RRGGBB"` / `--no-tint`) so instances are easy to tell
  apart in the Dock and Cmd-Tab.
- **Clone registry** — every clone is recorded in
  `~/.config/mac-app-dualizer/clones.json`.
- **`dualize` subcommands** — `list`, `repair` / `repair --all`, and
  `remove [--purge]`, in addition to `clone`.
- **Repair after auto-update** — `dualize repair` re-applies the patch (keeping
  the clone's data directory / login) when an app update reverts the clone.
- **Rollback on failure** — a failed clone cleans up its half-written bundle.
- **CI** — GitHub Actions running shellcheck + `node --check` + package.json
  validation.
- Issue/PR templates, `SECURITY.md`, and this changelog.

### Fixed
- **Clones crashed on launch with `EXC_BREAKPOINT` (SIGTRAP)** for apps built with
  Electron's asar-integrity fuse — Claude among them — whenever the CLI was run from a
  bare `git clone` ([#1]). The `ElectronAsarIntegrity` hash step used
  `npx -p @electron/asar node -e 'require("@electron/asar")…'`, but `npx -p` only puts
  a package's binaries on `PATH` and does not make it `require()`-able, so the step
  silently failed and left the hash stale. The hash is now computed with Node built-ins
  only (`src/asar-tools.js`), re-verified after signing, and any failure aborts the
  clone instead of printing "Done".
- The repacked `app.asar` keeps **exactly the original `app.asar.unpacked` layout**
  instead of a fixed `*.node / *.dylib / spawn-helper` glob (which missed, e.g., Claude's
  `github-mcp-server` binary), and the clone fails if the layout can't be reproduced.
- Files in `app.asar.unpacked` **keep their permissions**. `asar extract`/`pack` wrote them
  as `0644`, so node-pty's `spawn-helper` (Claude Code terminals), bundled MCP server
  binaries and native addons lost their executable bit in every clone.
- The isolation snippet is inserted **after** the entry file's `"use strict"` directive,
  so the app bundle keeps running in strict mode.
- The icon badge no longer silently skips when `pngjs` isn't installed locally; it is
  resolved from the `npx` cache as well.
- **Isolated clones of apps on newer Electron crashed on launch** with
  `Failed to get integrity for validatable asar archive: Resources/app.asar` (Claude
  desktop 5.x on Electron 45, [#5]). Those builds also embed a SHA-256 of the whole
  `ElectronAsarIntegrity` dictionary in the Electron Framework binary, so updating the
  hash in `Info.plist` alone made the dictionary fail that check. `update-integrity` now
  rewrites the embedded digest as well (before signing), and `check-integrity` and
  `dualize list` report a clone whose digest is stale as `needs repair (asar integrity
  digest)` instead of `ok`.
- `dualize list` / `dualize repair --all` health now also checks the asar integrity hash.
- Unsupported entry points (ES-module mains) are reported instead of producing a clone
  that shares the original's data.

[#1]: https://github.com/vishalmeena2211/mac-app-dualizer/issues/1
[#5]: https://github.com/vishalmeena2211/mac-app-dualizer/issues/5

## [1.0.0]

### Added
- Initial release: `clone-app.sh` CLI and Electron GUI to clone a macOS app into
  a second, independent instance (own identity, data directory, re-signed bundle,
  renamed Electron helpers).
