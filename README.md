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

Stratus is the first program in **[Ozone](https://github.com/GreenRu/Ozone)**, a
family of small, cloud-themed desktop programs — with **Nimbus** (text editor),
**Cumulus** (file explorer) and **Sky Box** (which installs and updates them) to
follow. What they share, and what any of them may not do, is the
[Ozone house style](https://github.com/GreenRu/Ozone/blob/main/docs/HOUSE-STYLE.md).

## Documentation

| Document | What is in it |
| --- | --- |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | How the processes, views and IPC fit together, and why the page is positioned the way it is |
| [docs/PRIVACY.md](docs/PRIVACY.md) | What is stored, where, and what never leaves the machine |
| [docs/PLUGINS.md](docs/PLUGINS.md) | Writing a plugin, with the full manifest reference |
| [docs/TESTING.md](docs/TESTING.md) | How the assertion suites work and how to run them |
| [PLAN.md](PLAN.md) | The working notes: what each check costs, and every trap found the hard way |

## What it does

### Browsing

- **Real browsing** on Chromium via `WebContentsView` — one view per tab, all
  owned by the main process.
- **Vertical cloud tabs**: open, close, activate, drag to reorder, middle-click
  to close, per-tab mute, live favicons and loading spinners. Each cloud is a
  rounded body with overlapping lobes, shaped from a hash of the tab id — so
  tabs look individual but never re-shuffle while you use them.
- **Merge and split.** Ctrl-click two or more clouds and merge them: they become
  one cloud showing several pages side by side. The seam between panes is
  draggable like a window splitter, and splitting them apart gives each its own
  cloud back with its page intact.
- **Drag a cloud** and it comes up out of the strip, tilted and shadowed under
  the pointer, with a gap opening where it will land.
- **A menu on every cloud**, drawn as a cloud itself. Right-click one for
  reload, duplicate, mute,
  keep as a droplet, copy address, move to top or bottom, reopen the last closed cloud,
  merge the ones you have picked or split a merged one, and close this / the
  others / everything below.
- **No top chrome.** Address bar, navigation and menus all live in the sidebar,
  which resizes by dragging its edge and collapses to icons on a double-click.
- **Full screen** hands the whole window to the pages: no furniture, no seam
  between merged panes, no rounded corners.
- **Navigation**: back, forward, reload, stop, home, zoom, find-in-page with
  match counts, print.

### The address bar, and its bubble

- **Omnibox** that tells a URL from a search query, with a connection badge
  (secure / not secure / internal page) and a droplet that keeps the page.
- **A live preview** hangs off it as you type: a real view of wherever Enter
  would take you, in a card that names the destination. Press it and it grows
  into the page.
- **The new tab page has its own search bar**, with the same live bubble. Each
  pane of a merged cloud gets its own — three panes can be searched at once,
  and opening one fills that pane rather than the window.
- **Search shortcuts**: `gt bonjour` opens Google Translate, `yt lofi` searches
  YouTube. Eleven ship by default (`g gt yt gh w mdn so npm ddg maps img`) and
  you can add your own in Settings, where `%s` marks the query.

### The browser's own pages

- **New tab** — a sky of shortcut clouds you can add to and remove, with a
  search bar of its own.
- **History** at `stratus://history` (`Ctrl+H`) — grouped by day with per-day
  counts, filtered by text and by time range, with favicons, forget-one-page and
  clear-a-whole-day.
- **Droplets** at `stratus://droplets` (`Ctrl+Shift+O`) — what other browsers
  call bookmarks. A cloud leaves droplets behind.

- **Settings** at `stratus://settings` (`Ctrl+,`) — search engine, home page,
  reopening the last session, page zoom, address-bar display, theme, saved
  logins, plugins, and browsing data.
- **Error page** for failed loads, with a retry button.

### Weather

- **Day and night themes**, applied to the chrome, the native titlebar overlay
  and the browser's own pages together, and to websites through
  `prefers-color-scheme`.
- **Stars at night, birds by day**, on the browser's own pages. The hidden one
  is fully paused, so it costs nothing.
- **Closing a cloud** takes it out of the strip, floats it down below the
  new-cloud button and rains it out there, gathering a puddle along the foot of
  the sky if there is room for one.
- **Merging** slides the joined clouds up into the one they joined rather than
  raining them out.

### Kept for you

- **Droplets** — kept pages, in a row above the page that `Ctrl+Shift+B` shows
  and hides. Right-click one to open it, open it in a new cloud, copy its link
  or delete it.
- **Flights** — what a download is called here, because it arrives. The plane
  on the toolbar says how many are in the air and opens a panel to hold, resume,
  cancel or retry them — press it again to put the panel away. Nothing flies
  about the window while you are reading. `stratus://flights` (`Ctrl+J`) is the
  whole record, kept between launches, and a name already in use is numbered
  rather than written over.
- **Saved passwords**, encrypted with the OS keystore — see
  [docs/PRIVACY.md](docs/PRIVACY.md).
- **Saved cards**, encrypted the same way. Only the last four digits and the
  expiry are kept in the clear, and a checkout is filled only once you put the
  cursor in a card field. Keeping the code on the back is **off by default**;
  see [The security code](docs/PRIVACY.md#the-security-code) for the one rule
  worth knowing about it.
- **History**, persisted to disk.
- **Session restore** (optional): the clouds you had open come back next launch,
  as does the window position, size and sidebar width.
- Downloads report progress and offer *Show in folder*.

### Bringing things over from another browser

**Settings → Bring things over** finds Chrome, Edge, Brave, Vivaldi, Opera,
Chromium and Firefox on this computer and reads their bookmarks straight out of
their own files — nothing to export, and a second run adds nothing twice.

Passwords are deliberately **not** read that way. They are sealed to the browser
that saved them, and prising them out would mean doing what a password stealer
does. Export them from that browser instead and read the file here; the same
door takes cards.

| From | Read as |
| --- | --- |
| Bookmarks | The browser's own file, or the HTML file every browser exports |
| Passwords | A CSV exported from the other browser |
| Cards | A CSV exported from the other browser |

### Plugins

Three ship with the browser and **all of them start switched off** — nothing
runs until you ask for it, in **Settings → Plugins**.

| Plugin | What it adds |
| --- | --- |
| **Make Your Own Theme** | A *Custom* entry in the theme list with every one of the interface's 40 colours editable, and a switch for whether websites are asked for their dark theme |
| **Page Timeline** | A button between back and forward, opening a branching map of where each cloud has been — including the paths you turned back from, which the browser's own history throws away |
| **Quiet Reader** | A reading width you can toggle, and an `arch` keyword for the Internet Archive |

Writing your own is [docs/PLUGINS.md](docs/PLUGINS.md).

## Keyboard

| Shortcut | Action |
| --- | --- |
| `Ctrl+T` / `Ctrl+W` | New tab / close tab |
| `Ctrl+Shift+T` | Reopen the cloud you closed last |
| `Ctrl+Tab` / `Ctrl+Shift+Tab` | Next / previous tab |
| `Ctrl+1`…`Ctrl+8`, `Ctrl+9` | Nth tab, last tab |
| `Ctrl+L`, `Alt+D` | Focus the address bar |
| `Alt+←` / `Alt+→` / `Alt+Home` | Back / forward / home |
| `Ctrl+R`, `Ctrl+Shift+R` | Reload, reload ignoring cache |
| `Ctrl+F`, `Esc` | Find in page, close find / stop loading |
| `Ctrl+D` | Keep this page as a droplet |
| `Ctrl+Shift+B` | Show or hide the droplet bar |
| `Ctrl+H`, `Ctrl+Shift+O`, `Ctrl+J` | History, droplets, flights |
| `Ctrl+=` / `Ctrl+-` / `Ctrl+0` | Zoom in / out / reset |
| `Ctrl+,` | Settings |
| `Ctrl+Shift+I`, `F12` | Developer tools for the page |

Shortcuts are registered on the (hidden) application menu rather than as
renderer key handlers, so they still fire while a web page has focus. Plugins
can add their own — the bundled Quiet Reader takes `Ctrl+Alt+R`.

## Layout

```
src/
  main/          Electron main process
    index.js       app lifecycle, IPC surface, session + download handling
    shell.js       the window: tab set, layout, previews, context menus, state
    tab.js         one tab = one WebContentsView, its state and its trail
    menu.js        application menu (the keyboard map) and the toolbar menu
    store.js       JSON preferences, droplets, history in the user-data dir
    urls.js        URL vs. search parsing, shortcuts, stratus:// routing
    passwords.js   the encrypted login vault
    plugins.js     the plugin host: manifests, injection, themes, toolbar
    sky.js         the shortcut clouds on the new tab page
    flights.js     downloads: where they land, what may be done to one
  preload/
    chrome.js      context bridge for the browser UI
    page.js        bridges for the browser's own pages and for plugin pages
    preview.js     the address bar preview: swallows interaction, forwards a press
    bubble.js      the card drawn around that preview
  renderer/        the browser UI (sidebar, drawers, page card)
    cloud-tabs.js    cloud rendering, drag-to-reorder, closing and merging
  pages/           new tab, history, droplets, settings, error, preview card
  shared/          loaded by both the UI and the browser's own pages
    clouds.js        the cloud silhouette generator
    theme.js         applying a theme, built-in or from a plugin
    stars.js         the night sky
    birds.js         the day sky
plugins/         bundled plugins, all switched off until asked for
docs/            the documents listed above
tools/           Windows registration, shortcut and icon scripts
```

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

That puts a *Stratus* shortcut on the desktop which launches the app through
`node_modules/electron/dist/electron.exe` — an unsigned binary too, but one
whose hash is on millions of machines, so it has reputation and runs. No
security setting is weakened, and deleting the shortcut undoes it.

Smart App Control can also start blocking that Electron binary mid-session. The
verdict is pinned to the file rather than its contents — copying the same bytes
elsewhere runs — so `npm rebuild electron` clears it. Turning Smart App Control
off is the wrong fix: it cannot be turned back on without reinstalling Windows.

Shipping to other people needs a real code signing certificate. The free route
is the [SignPath Foundation](https://signpath.org/apply), which requires an
OSI-licensed, already-released, actively maintained public project.

## The icon

```bash
npm run icon
```

`assets/icon.ico` is generated, not hand-drawn:
[tools/make-icon.ps1](tools/make-icon.ps1) renders the logo's own geometry at
nine sizes from 16px to 256px and packs them into one file. Drawing each size
rather than downsampling one bitmap is what keeps the 16px version legible in a
taskbar.

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
`Software\<App>\Capabilities` makes Windows treat the program as *an app*; to be
offered as a *browser* it has to live under
`Software\Clients\StartMenuInternet\<name>` with a
`Capabilities\StartMenu\StartMenuInternet` value pointing back at itself. That
is how Edge and Firefox are registered, and the script mirrors their shape key
for key.

That alone still is not enough. The Default apps page lists *installed*
applications, so the script also creates a Start menu shortcut and an entry
under Installed apps — the two things that make Windows consider a program
installed at all.

Two smaller details matter as much:

- Entries in `OpenWithProgids` must be an **empty `REG_SZ`**. A zero-length
  `REG_BINARY` looks equivalent and is silently ignored.
- The name shown in *Open with* comes from the **executable's version
  resource**, not from anything registered — so the development launcher would
  appear as "Electron". `FriendlyAppName` on the application key overrides it.

Twenty-two file types are claimed, all of them things Chromium can genuinely
display: `.html`, `.svg`, `.pdf`, `.txt`, `.json`, `.xml` and the common image
formats. Word documents are deliberately not among them — Chromium cannot
render `.doc` or `.docx`, which is why Edge hands those to Office instead.

## Not built yet

Multiple windows, tab groups, a download manager UI, a permission prompt
(non-essential permissions are currently denied), omnibox autocomplete, and an
account picker for sites with several saved logins. The plumbing is in place for
each: `shells` is already an array, `Store` takes arbitrary keys, and
permissions are gated in one place in `src/main/index.js`.

## Icons

From [css.gg](https://css.gg) by Astrit, tag `2.1.1`, under the MIT licence. The
set is shared across the family and lives in
[Ozone/icons](https://github.com/GreenRu/Ozone/tree/main/icons); `src/shared/icons.js`
here is generated from it and committed, so this repository stands on its own.

Later css.gg releases are licensed for non-commercial use only, which cannot
ship in a GPL program - hence the pinned version.

The program's own cloud mark is not from the set and is drawn by hand.

## License

Stratus is free software under the [GNU General Public License v3](LICENSE) or
later. It comes with no warranty. Anything you build on it and distribute has to
carry the same freedoms — including the source.

Electron and Chromium ship under their own licences (MIT and BSD-style), which
GPL-3 permits.
