# Stratus

A small desktop web browser built on Electron. One sky fills the window, every
tab is a cloud drifting down the left edge, and the page floats on it as a
single rounded card — there is no toolbar band across the top.

```bash
npm install
npm start
```

> Renamed from *Cloud Browser*. The profile is carried over automatically on
> first launch — including `Local State`, without which every saved password
> would be unreadable ciphertext — and stored `cloud://` addresses are rewritten
> to `stratus://`.

## What it does

- **Real browsing** on Chromium via `WebContentsView` — one view per tab, all
  owned by the main process.
- **Vertical cloud tabs**: open, close, activate, drag to reorder, middle-click
  to close, per-tab mute, live favicons and loading spinners. Each cloud is a
  rounded body with long overlapping lobes, shaped from a hash of the tab id —
  so tabs look individual but never re-shuffle while you use them.
- **No top chrome.** Address bar, navigation and menus all live in the sidebar,
  which resizes by dragging its edge and collapses to icons on a double-click.
- **Omnibox** that tells a URL from a search query, with a connection badge
  (secure / not secure / internal page) and a bookmark star.
- **Search shortcuts**: `gt bonjour` opens Google Translate, `yt lofi` searches
  YouTube. Eleven ship by default (`g gt yt gh w mdn so npm ddg maps img`) and
  you can add your own in Settings, where `%s` marks the query.
- **Saved passwords**, encrypted with the OS keystore — see below.
- **Settings page** at `stratus://settings` (`Ctrl+,`) for the search engine,
  home page, theme, address-bar display, shortcuts, saved logins and clearing
  history.
- **Trimmed addresses** (optional): the bar can show just the site —
  `news.ycombinator.com` — and reveal the whole address when you click it.
- **Navigation**: back, forward, reload, stop, home, zoom, find-in-page with
  match counts, print.
- **Bookmarks and history**, persisted to disk, each with its own built-in page.
- **Day and night themes**, applied to the chrome, the native titlebar overlay
  and the built-in pages together.
- **Session restore**: the tabs you had open come back on next launch, as does
  the window position, size and sidebar width.
- Downloads report progress and offer *Show in folder*; failed loads land on a
  themed error page with a retry button.

## Keyboard

| Shortcut | Action |
| --- | --- |
| `Ctrl+T` / `Ctrl+W` | New tab / close tab |
| `Ctrl+Tab` / `Ctrl+Shift+Tab` | Next / previous tab |
| `Ctrl+1`…`Ctrl+8`, `Ctrl+9` | Nth tab, last tab |
| `Ctrl+L`, `Alt+D` | Focus the address bar |
| `Alt+←` / `Alt+→` / `Alt+Home` | Back / forward / home |
| `Ctrl+R`, `Ctrl+Shift+R` | Reload, reload ignoring cache |
| `Ctrl+F`, `Esc` | Find in page, close find / stop loading |
| `Ctrl+D` | Bookmark this page |
| `Ctrl+H`, `Ctrl+Shift+O` | History, bookmarks |
| `Ctrl+=` / `Ctrl+-` / `Ctrl+0` | Zoom in / out / reset |
| `Ctrl+,` | Settings |
| `Ctrl+Shift+I`, `F12` | Developer tools for the page |

Shortcuts are registered on the (hidden) application menu rather than as
renderer key handlers, so they still fire while a web page has focus.

## Layout

```
src/
  main/        Electron main process
    index.js     app lifecycle, IPC surface, session + download handling
    shell.js     the window: tab set, layout, context menus, state broadcast
    tab.js       one tab = one WebContentsView + its presentation state
    menu.js      application menu (the keyboard map) and the toolbar menu
    store.js     JSON preferences, bookmarks, history in the user-data dir
    urls.js      URL vs. search parsing, shortcuts, stratus:// page routing
    passwords.js the encrypted login vault
  preload/
    chrome.js    context bridge for the browser UI
    page.js      minimal bridge, installed only for the built-in pages
  renderer/      the browser UI (sidebar, drawers, page card)
    cloud-tabs.js  cloud tab rendering and drag-to-reorder
  pages/         new tab, history, bookmarks, settings and error pages
```

The renderer never touches browsing state directly. It receives `shell:state`
snapshots and sends intents back over a small, explicitly enumerated IPC
surface; `nodeIntegration` is off and `contextIsolation` on everywhere, and web
pages run sandboxed in their own persistent session partition.

### How the page gets positioned

A `WebContentsView` is a native child of the window, not part of the UI
document, so it has to be positioned manually. The renderer keeps an empty
`.stage` element exactly where the page belongs and reports its rect as insets
from the window edges; the main process turns those back into bounds. Opening
the find bar or resizing the sidebar therefore moves the page automatically,
with no hard-coded chrome height anywhere.

## How saved passwords work

Secrets are encrypted with Electron's `safeStorage`, which delegates to the OS
keystore — DPAPI on Windows, Keychain on macOS, libsecret or kwallet on Linux.
Only ciphertext reaches `logins.json`, and the key is bound to both the OS user
and this profile's `Local State`, so copying the file elsewhere yields nothing.
If a platform reports no keystore, saving is refused rather than falling back to
plaintext: a password store that quietly isn't one is worse than none.

A few rules keep credentials where they belong:

- **The page never says which origin it is.** The renderer sends only the
  submitted values; the main process reads the origin from the sending tab's
  own URL. A compromised page cannot ask for another site's credentials.
- **Origins must match exactly** — scheme, host and port. `https://example.com`
  will not fill on `http://example.com` or on `sub.example.com`.
- **Top frame only.** A cross-origin iframe is never filled.
- **Nothing is filled when several accounts are stored** for one origin, until
  there is a picker to choose with.
- **Nothing is exposed to page JavaScript.** The capture-and-fill half of
  `src/preload/page.js` makes no `contextBridge` call at all; it only listens to
  DOM events inside the isolated world.

Sites can be declined permanently ("Never"), and every saved login can be
revealed — auto-hiding after 15 seconds — or deleted in Settings.

## Building

```bash
./build.sh                      # build for this machine
./build.sh --platform win32 --arch x64
./build.sh --zip                # also produce an archive
./build.sh --clean              # wipe dist/ first
```

The script checks the toolchain, installs dependencies if they are missing,
parses every source file before it packages anything, and reports where the
build landed. `npm run package` does the same thing without the checks.

Output goes to `dist/`. The `CloudBrowser-win32-x64/` folder at the repo root
is a stale build of the previous version and can be deleted.

### Windows 11: the packaged build will not start

Smart App Control blocks executables that are both unsigned and unknown to
Microsoft's reputation graph. A freshly packaged build is exactly that, so
Windows refuses to run it and logs Code Integrity event 3077. Nothing is wrong
with the build; a self-signed certificate does not help, because Smart App
Control only trusts certificates that chain to a CA Microsoft recognises.

For running it on your own machine, skip packaging and make a shortcut:

```bash
npm run shortcut
```

That puts a *Stratus* shortcut on the desktop which launches the app
through `node_modules/electron/dist/electron.exe` — an unsigned binary too, but
one whose hash is on millions of machines, so it has reputation and runs. No
security setting is weakened, and deleting the shortcut undoes it.

Shipping to other people needs a real code signing certificate. The free route
is the [SignPath Foundation](https://signpath.org/apply), which requires an
OSI-licensed, already-released, actively maintained public project — worth
applying for once this is on GitHub with releases.

## Opening files, and being the default browser

```bash
npm run register     # publish Stratus to Windows
npm run unregister   # take it back out
```

Windows has not let an application make itself the default since Windows 10
1803 — that is the user's choice alone. Registering publishes what Stratus can
open, which makes it appear in **Settings → Apps → Default apps**, where you
assign `http`, `https` and whichever file types you want. Everything is written
under `HKEY_CURRENT_USER`, so it needs no administrator rights and touches no
other account.

The layout matters more than it looks. A registration under
`Software\<App>\Capabilities` makes Windows treat the program as *an app*; to
be offered as a *browser* it has to live under
`Software\Clients\StartMenuInternet\<name>` with a
`Capabilities\StartMenu\StartMenuInternet` value pointing back at itself. That
is how Edge and Firefox are registered, and the script mirrors their shape
key for key.

That alone still is not enough. The Default apps page lists *installed*
applications, so the script also creates a Start menu shortcut and an entry
under Installed apps — the two things that make Windows consider a program
installed at all. Every browser on this machine has both; a registry-only
registration is invisible to that page.

Two smaller details matter as much:

- Entries in `OpenWithProgids` must be an **empty `REG_SZ`**. A zero-length
  `REG_BINARY` looks equivalent and is silently ignored.
- The name shown in *Open with* comes from the **executable's version
  resource**, not from anything registered — so the development launcher would
  appear as "Electron". `FriendlyAppName` on the application key overrides it.
  A packaged build carries the right name itself.

Twenty-two file types are claimed, all of them things Chromium can genuinely
display: `.html`, `.svg`, `.pdf`, `.txt`, `.json`, `.xml` and the common image
formats. Word documents are deliberately not among them — Chromium cannot
render `.doc` or `.docx`, which is why Edge hands those to Office rather than
opening them itself.

Smart App Control is not an obstacle here. It blocks a freshly *packaged*
build, but the registration points at the same Electron binary the shortcut
uses, which has reputation and runs — verified by opening a file through the
registered handler with no Code Integrity block logged.

## Plugins

`plugins/` is reserved for the plugin system and is not loaded yet; see
[plugins/README.md](plugins/README.md) for the intended manifest shape and the
hook points that already exist.

## Not built yet

Multiple windows, tab groups, the plugin host, download manager UI, a
permission prompt (non-essential permissions are currently denied), omnibox
autocomplete, and an account picker for sites with several saved logins. The plumbing is in place for each: `shells` is already an array,
`Store` takes arbitrary keys, and permissions are gated in one place in
`src/main/index.js`.

## License

Stratus is free software under the [GNU General Public License v3](LICENSE) or
later. It comes with no warranty. Anything you build on it and distribute has
to carry the same freedoms - including the source.

Electron and Chromium ship under their own licences (MIT and BSD-style), which
GPL-3 permits.
