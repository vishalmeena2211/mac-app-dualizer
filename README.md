# App Dualizer

<p>
  <img alt="macOS" src="https://img.shields.io/badge/macOS-supported-000000?logo=apple&logoColor=white" />
  <img alt="Windows" src="https://img.shields.io/badge/Windows-supported-0078D6?logo=windows&logoColor=white" />
  <img alt="license" src="https://img.shields.io/badge/license-MIT-blue" />
  <img alt="PRs welcome" src="https://img.shields.io/badge/PRs-welcome-56b877" />
</p>

Run **two independent instances** of an app at the same time — each with its own
data directory and its own login. Great for using two accounts of the same app
(two Claude, Slack, Notion, or Discord logins) side by side.

- **CLI** — `clone-app.sh` (macOS) or `clone-app.ps1` (Windows), plus a few small
  dependency-free Node helpers in `src/` (no `npm install` needed).
- **GUI** — a small Electron app: drag in an app, name the clone, click **Clone**.

Works best with **Electron apps** (Claude, Slack, Notion, VS Code, Discord,
Figma, …) — which happens to be most of the "only one account per app" apps
people want to double.

> ⚠️ Clone only apps you're licensed to use, and respect each app's Terms of
> Service. This is a tool for legitimate multi-account / multi-profile use on
> your own machine.

> **Windows support is new.** It is covered by an automated test suite that runs
> on a real Windows runner in CI, but it has seen far less real-world use than
> the macOS path. Reports of what works and what doesn't are very welcome in
> [Issues](https://github.com/vishalmeena2211/mac-app-dualizer/issues).

*(The repository keeps the `mac-app-dualizer` name; the tool itself now covers both platforms.)*

---

## Why this exists

This started with a very specific itch: **running more than one Claude desktop
instance — each signed into a different account — on the same machine.**

The Claude desktop app (which hosts **Claude Code**) supports many parallel
*sessions*, but only **one signed-in account** per install. If you have, say, a
personal account and a work/org account, there's no built-in way to be logged
into both at once.

The usual `open -n -a "Claude"` trick doesn't help either: a second copy shares
the **same data directory**, so it shares the same login and fights over lock
files. To get a *genuinely* separate instance you need a distinct identity, a
separate data directory, and — on macOS — matching Electron helper names and a
valid re-signature. We worked that out by hand for Claude, then generalized it
into this tool so anyone can do it for any app.

See **[Example: two Claude instances](#example-two-claude-instances-different-accounts)** below.

---

## Requirements

**macOS**

- macOS (Apple Silicon or Intel)
- **Xcode Command Line Tools** — for `codesign`: `xcode-select --install`
- **Node.js** (18+)

**Windows**

- Windows 10 or 11, PowerShell 5.1+ (built in)
- **Node.js** (18+)
- No administrator rights needed — clones default to `%LOCALAPPDATA%\Programs`

The CLI needs **no `npm install`**: it fetches `@electron/asar` on demand through
`npx`, and everything else it does is Node built-ins only. `npm install` is only
required for the GUI.

---

## Quick start — CLI

### macOS

```bash
git clone https://github.com/vishalmeena2211/mac-app-dualizer.git
cd mac-app-dualizer
npm install
chmod +x clone-app.sh

./clone-app.sh --source "/Applications/Slack.app" --name "Slack Work"
open -a "Slack Work"
```

Its data lives in `~/Library/Application Support/Slack Work`.

### Windows

```powershell
git clone https://github.com/vishalmeena2211/mac-app-dualizer.git
cd mac-app-dualizer
npm install

.\clone-app.ps1 -Source "$env:LOCALAPPDATA\Programs\slack\slack.exe" -Name "Slack Work"
```

Its data lives in `%APPDATA%\Slack Work`, completely separate from the original —
so you can log into a **different account**. Launch the clone from its new
**Start Menu** entry.

GNU-style flags work too, so the two platforms read the same:

```powershell
.\clone-app.ps1 --source "C:\Program Files\Claude\Claude.exe" --name "Claude 2" --desktop
```

---

## Two modes (Windows)

Windows can isolate an app *without modifying it*, which macOS cannot. So the
Windows tool offers a second, lighter mode:

| | `clone` (default) | `link` |
|---|---|---|
| Copies the app | Yes, to `%LOCALAPPDATA%\Programs` | No |
| How data is isolated | Injected into `app.asar` **and** `--user-data-dir` | `--user-data-dir` only |
| Distinct icon & taskbar identity | Yes | No — shares the original's |
| Survives the app auto-updating | No — run `dualize repair` | **Yes, permanently** |
| Works if the app enforces ASAR integrity | Yes (via the shortcut) | Yes |

```powershell
# Lightweight: no copy, never needs repairing
.\clone-app.ps1 --source "$env:LOCALAPPDATA\Programs\slack\slack.exe" --name "Slack Work" --mode link
```

Pick **link** if you mostly care about a second login and don't mind both
instances sharing one icon. Pick **clone** if you want the second instance to
look and feel like its own app.

### Options

| Flag | Platforms | Meaning |
|------|-----------|---------|
| `--source PATH` | both | The `.app` (macOS) or `.exe` (Windows) to clone (required) |
| `--name NAME` | both | Display name for the clone, e.g. `"Slack Work"` (required) |
| `--dest-dir DIR` | both | Where to write the clone |
| `--no-isolate` | both | Don't inject a separate data directory (Electron only) |
| `--tint "#RRGGBB"` | both | Icon badge color (default: auto-picked from the name) |
| `--no-tint` | both | Don't badge the clone's icon |
| `--strip-schemes` | macOS | Remove the app's custom URL schemes from the clone |
| `--mode clone\|link` | Windows | See the table above (default: `clone`) |
| `--desktop` | Windows | Also create a Desktop shortcut |

---

## Managing clones

Every clone is recorded in a small JSON registry, so you can manage them with the
`dualize` command on either platform:

```bash
node bin/dualize.js list                 # show clones + health (signature + asar hash)
node bin/dualize.js repair "Slack Work"  # re-apply after an app auto-update (keeps the login)
node bin/dualize.js repair --all         # repair every unhealthy clone
node bin/dualize.js remove "Slack Work"  # delete the clone (add --purge to also delete its data)
```

The registry lives at `~/.config/mac-app-dualizer/clones.json` on macOS and
`%APPDATA%\mac-app-dualizer\clones.json` on Windows.

**Distinct icons.** Each clone gets a small colored badge on its icon (auto-picked
from its name, or set with `--tint`) so you can tell instances apart. The color is
derived from the clone name, so a given name gets the same color on both
platforms. On macOS, run `killall Dock` if the icon doesn't refresh; on Windows
the badge is applied to the shortcut's icon.

**Repair after updates.** When an app auto-updates it overwrites the clone's
files, reverting the rename/injection. `dualize repair` detects this and
re-applies the patch — your **data directory / login is untouched**. Windows
`link` clones never need repairing.

---

## Quick start — GUI

```bash
npm install
npm start
```

1. **Drag an app** onto the window (or click **Browse**). Its real icon, version
   or bundle id, and an *Electron / Native* badge appear.
2. Give the clone a name. On Windows, choose **Full clone** or **Shortcut only**.
3. Click **Clone app**, watch the log, then **Launch clone**.

---

## Example: two Claude instances (different accounts)

**macOS**

```bash
./clone-app.sh --source "/Applications/Claude.app" --name "Claude 2"
open -a "Claude 2"
```

**Windows**

```powershell
.\clone-app.ps1 --source "$env:LOCALAPPDATA\Programs\Claude\Claude.exe" --name "Claude 2"
```

You'll now have the original **Claude** and a second **Claude 2**, each with its
own data directory — so each can be signed into a different account, both running
at once (including separate **Claude Code** sessions).

**Logging the clone into a second account.** Because a magic link only
authenticates the app that opens it, and the OS routes `claude://` deep links to
your *original* app, start the **"Continue with email"** flow *inside the Claude 2
window* — since that instance initiated it, completing the link logs it in.

On macOS you can also deliver the link explicitly:

```bash
open -a "Claude 2" "claude://magic-link#<token-from-your-login-email>"
```

> Heads-up: keep the clone's `productName` unchanged (the tool does this for
> you). Renaming it makes the web login flow think it's a browser and show the
> marketing site instead of the app sign-in.

---

## How it works

### macOS

1. **Copies** the bundle with `ditto`.
2. **Rewrites the identity** — a unique `CFBundleIdentifier` and a new
   `CFBundleName` / `CFBundleDisplayName`.
3. *(Electron)* **Renames the helper apps** in `Contents/Frameworks`, because
   Electron locates helpers by the main app's name.
4. *(Electron)* **Injects an isolated data directory** by inserting a tiny
   snippet at the top of the app's main script inside `app.asar` (right after its
   `"use strict"` directive, so the bundle keeps running in strict mode):
   ```js
   require('electron').app.setPath(
     'userData',
     require('path').join(app.getPath('appData'), '<Clone Name>')
   );
   ```
   It then repacks `app.asar` **keeping exactly the original set of files in
   `app.asar.unpacked`, with their original permissions** (native modules and
   helper binaries can't run from inside an archive, and they must stay
   executable) and **recomputes the `ElectronAsarIntegrity` hash** in
   `Info.plist`. Apps built with Electron's asar-integrity fuse — Claude is one —
   refuse to start if that hash is stale, so the script verifies it again after
   signing and fails instead of producing a clone that would crash.
   *`productName` is deliberately left unchanged, so the app's user-agent and any
   server-side "is this the desktop app?" detection keep working — important for
   web-based login flows.*
5. **Re-signs** the bundle ad-hoc (`codesign --force --deep --sign -`).
6. **Registers** it with Launch Services (`lsregister -f`).

### Windows

Windows has no bundle identifier, no helper apps to rename, and no signature that
must be repaired for the app to launch — but it also has no editable
`Info.plist`. Each macOS step maps to something different:

| macOS | Windows |
|---|---|
| `CFBundleIdentifier` rewrite | Rename `App.exe` → `Clone.exe`, plus a distinct `AppUserModelID` that drives taskbar grouping |
| Rename Electron helper `.app`s | Not needed — Windows Electron reuses one executable with `--type=` |
| `codesign --force --deep` | Nothing. Windows runs modified executables; only the Authenticode signature goes invalid |
| `lsregister -f` | `.lnk` shortcuts in the Start Menu (and optionally the Desktop) |
| `iconutil` + `.icns` badge | Read `RT_GROUP_ICON`/`RT_ICON` from the executable's PE resources, badge each frame, rebuild a `.ico` |
| `codesign --verify` health check | A sentinel file in the clone plus an `app.asar` size/timestamp check |
| `~/Library/Application Support/<Name>` | `%APPDATA%\<Name>` |

The injected snippet does slightly more on Windows: as well as pointing
`userData` at the clone's own directory, it wraps `app.setPath` so an app that
later sets its own `userData` path can't undo the isolation.

**Shortcuts always carry `--user-data-dir` too.** That redundancy is deliberate —
see the caveat below.

---

## Caveats

### Both platforms

- **Auto-updates revert the clone.** When the app updates itself it overwrites the
  copy, wiping the rename/injection. Just run `dualize repair` afterward — the
  clone's **data directory (your login) is untouched**. (Windows `link` clones are
  immune.)
- **Non-Electron apps.** The tool changes the identity — which gives *sandboxed*
  macOS apps a fresh container — but can't guarantee data isolation for arbitrary
  native apps.
- **Not affiliated** with Anthropic or any app you clone. Use responsibly and
  within each app's license and Terms of Service.

### macOS

- **Gatekeeper.** Ad-hoc signing is fine for locally-built clones. If you move a
  clone to another Mac, clear quarantine:
  `xattr -dr com.apple.quarantine "/Applications/Claude 2.app"`.

### Windows

- **ASAR integrity.** Electron can embed an integrity hash for `app.asar` *inside
  the executable*, where — unlike the macOS `Info.plist` — this tool cannot
  recompute it. When that's detected, injection is skipped and the clone is
  isolated by the shortcut's `--user-data-dir` instead. The tool tells you when
  this happens; **launch such a clone from its Start Menu entry**, not by
  double-clicking the `.exe`.
- **SmartScreen.** Modifying an executable invalidates its Authenticode
  signature. The app still runs, but Windows may show a "Windows protected your
  PC" prompt the first time; choose *More info → Run anyway*.
- **Taskbar grouping in `link` mode.** Both instances share one executable and one
  icon, so Windows groups them together. Use `clone` mode if you want them
  separated.
- **URL schemes / deep links** are registered per-user in the Windows registry.
  This tool does not touch them, so the original app keeps handling `claude://`
  and similar links.

---

## Troubleshooting

**The clone crashes the instant it opens.** The crash report says
`EXC_BREAKPOINT (SIGTRAP)` in `Electron Framework` a fraction of a second after
launch (Console shows `Integrity check failed for asar archive`). The app checks
its `app.asar` against the `ElectronAsarIntegrity` hash in `Info.plist`, and the
clone's hash is stale. Versions of this tool before September 2026 could leave it
stale when the CLI was run from a bare `git clone` — the hash step depended on
`@electron/asar` being `require()`-able and silently skipped when it wasn't
([#1](https://github.com/vishalmeena2211/mac-app-dualizer/issues/1)). Pull the
latest version, then rebuild the clone; its data directory (your login) is kept:

```bash
node bin/dualize.js list                 # "needs repair (asar integrity hash)"
node bin/dualize.js repair "Claude 2"    # re-applies the patch on top of the current app
```

If the clone predates the registry (`dualize list` doesn't know it), delete the
`.app` and run `clone-app.sh` again with the same name.

**"could not inject the data-isolation snippet".** The app's main script isn't a
CommonJS file the tool knows how to patch (e.g. an ES-module entry). Clone with
`--no-isolate` to get a separately-identified copy that still shares the
original's data, and please open an issue naming the app.

---

## Uninstall a clone

The `dualize remove` command handles this on both platforms, including
shortcuts:

```bash
node bin/dualize.js remove "Claude 2" --purge
```

Or by hand:

```bash
# macOS
rm -rf "/Applications/Claude 2.app"
rm -rf "$HOME/Library/Application Support/Claude 2"
```

```powershell
# Windows
Remove-Item -Recurse -Force "$env:LOCALAPPDATA\Programs\Claude 2"
Remove-Item -Recurse -Force "$env:APPDATA\Claude 2"
Remove-Item "$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Claude 2.lnk"
```

---

## Development

```bash
npm install
npm test          # runs on macOS, Windows, and Linux
```

The Windows engine is plain Node, so its tests — PE resource parsing, icon
badging, `app.asar` injection, and a full clone against a synthetic install
directory — run on any platform. CI additionally runs the suite on a real
`windows-latest` runner, where shortcut creation is exercised for real.

## Contributing

Issues and PRs are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md). Good first
areas: broader native-app support, embedding the badged icon into the cloned
`.exe` via `rcedit`, packaged builds, and testing against more Electron apps on
both platforms.

## Credits

Originally created by [@vishalmeena2211](https://github.com/vishalmeena2211) as
[mac-app-dualizer](https://github.com/vishalmeena2211/mac-app-dualizer). Windows
support added in this fork.

## License

MIT — see [LICENSE](LICENSE).
