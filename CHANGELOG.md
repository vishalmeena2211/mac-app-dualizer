# Changelog

All notable changes to this project are documented here.
Format loosely follows [Keep a Changelog](https://keepachangelog.com/).

## [Unreleased]

## [1.1.0] — Windows support

### Added
- **Windows support.** Clone a Windows app into a second instance with its own
  data directory and login. `clone-app.ps1` mirrors the macOS script's flags, and
  the `dualize` CLI and Electron GUI now work on both platforms.
- **Two Windows modes.** `--mode clone` copies the app, renames its executable,
  gives it a badged icon and its own `AppUserModelID`. `--mode link` creates only
  a shortcut carrying `--user-data-dir`, so nothing is copied and an app
  auto-update can never revert it.
- **Windows icon badging** — icons are read straight out of the executable's PE
  resource directory (`RT_GROUP_ICON` / `RT_ICON`), badged frame by frame, and
  rebuilt as an `.ico`. Badge colors match macOS for the same clone name.
- **ASAR integrity detection.** Electron on Windows embeds the integrity hash in
  the executable, where it cannot be recomputed. The tool detects this, skips
  injection rather than producing a clone that refuses to launch, and falls back
  to isolating via the shortcut.
- **Hardened isolation on Windows** — the injected snippet wraps `app.setPath` so
  an app that later sets its own `userData` path cannot undo the isolation.
- **Test suite** (`npm test`) covering PE parsing, icon badging, `app.asar`
  injection, name validation, health checks, and a full clone against a synthetic
  install directory. CI runs it on Ubuntu, macOS, and Windows, and parse-checks
  `clone-app.ps1` on a real Windows runner.

### Changed
- `registry.js` is now importable as a module as well as a CLI, and stores the
  registry under `%APPDATA%\mac-app-dualizer` on Windows.
- The GUI adapts its wording and options per platform, and surfaces per-clone
  warnings in the result panel.
- Badge geometry moved to `src/badge.js`, shared by both platforms.

### Fixed
- `@electron/asar` caches an archive's header by path; the Windows engine now
  invalidates that cache after repacking, so a long-lived process (the GUI) can't
  read a rewritten archive at stale offsets.
- `app.asar` is repacked to a scratch file, verified readable, and only then
  swapped in. Previously the original was deleted before its replacement was
  written, so a failure in between left the clone with no archive at all — and
  because injection failure is only a warning, that surfaced as a "successful"
  clone whose app could not start.
- Deletes retry, and cleanup of the scratch directory can no longer fail an
  injection that already succeeded. Windows refuses to remove a directory while
  any handle inside it is open, which made this fail intermittently.
- A clone that ends up with neither injection nor a shortcut is now reported
  instead of being presented as isolated when it would silently share the
  original app's data.
- `dualize remove` explains that a clone must be quit before it can be deleted,
  rather than surfacing a raw filesystem error.

### Added (earlier, macOS)
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
- `dualize list` / `dualize repair --all` health now also checks the asar integrity hash.
- Unsupported entry points (ES-module mains) are reported instead of producing a clone
  that shares the original's data.

[#1]: https://github.com/vishalmeena2211/mac-app-dualizer/issues/1

## [1.0.0]

### Added
- Initial release: `clone-app.sh` CLI and Electron GUI to clone a macOS app into
  a second, independent instance (own identity, data directory, re-signed bundle,
  renamed Electron helpers).
