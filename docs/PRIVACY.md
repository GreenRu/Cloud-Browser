# What Stratus keeps, and where

Short version: everything stays on your machine, in the OS user-data directory,
and **none of it is in this repository or has ever been**.

## Where the profile lives

| Platform | Directory |
| --- | --- |
| Windows | `%APPDATA%\Stratus` |
| macOS | `~/Library/Application Support/Stratus` |
| Linux | `~/.config/Stratus` |

That folder is nowhere near the source tree. Nothing in it is tracked, and the
repository's history has never contained anything but source, documentation and
build scripts.

`.gitignore` also names the profile's files by hand — `logins.json`,
`state.json`, `Local State`, `Cookies`, the cache and storage directories. None
of that can be reached from the repository, but a profile copied in for
debugging, or a test run pointed at the wrong place, would otherwise be
committable by accident.

## What is in it

| File or folder | Holds |
| --- | --- |
| `logins.json` | Saved logins. Usernames in the clear, **passwords only ever as ciphertext** |
| `state.json` | Preferences, bookmarks, history, the last session, window bounds, plugin settings |
| `Local State` | Chromium's own state, including the key the vault is bound to |
| `Cookies`, `Local Storage`, `IndexedDB`, `Network/` | What websites stored, exactly as any browser keeps it |
| `Cache/`, `Code Cache/`, `GPUCache/` | Chromium's caches |
| `plugins/` | Plugins you installed yourself |

## Saved passwords

Secrets are encrypted with Electron's `safeStorage`, which delegates to the OS
keystore — DPAPI on Windows, Keychain on macOS, libsecret or kwallet on Linux.
Only ciphertext reaches `logins.json`, and the key is bound to both the OS user
and this profile's `Local State`, so copying the file elsewhere yields nothing.

**If a platform reports no keystore, saving is refused** rather than falling back
to plaintext. A password store that quietly isn't one is worse than none.

A few rules keep credentials where they belong:

- **The page never says which origin it is.** The renderer sends only the
  submitted values; the main process reads the origin from the sending tab's own
  URL. A compromised page cannot ask for another site's credentials.
- **Origins must match exactly** — scheme, host and port. `https://example.com`
  will not fill on `http://example.com` or on `sub.example.com`.
- **Top frame only.** A cross-origin iframe is never filled.
- **Nothing is filled when several accounts are stored** for one origin, until
  there is a picker to choose with.
- **Nothing is exposed to page JavaScript.** The capture-and-fill half of
  `src/preload/page.js` makes no `contextBridge` call at all; it only listens to
  DOM events inside the isolated world.

Sites can be declined permanently ("Never"), and every saved login can be
revealed — auto-hiding after 15 seconds — or deleted, in **Settings →
Passwords**.

## What you can clear, and from where

**Settings → Browsing data** has:

- **Remember pages you visit** — off stops anything new being written down, and
  leaves what is already there.
- **Clear browsing history** — the history list only.
- **Clear cookies and site data** — cookies, storage and caches. Sites you were
  signed in to will ask again. Your history is untouched.

History can also be pruned a page or a day at a time on the History page itself.

## What plugins can see

Nothing, unless you switch one on — plugins ship switched off.

Once one is on, its JavaScript runs **only inside a page, in an isolated world**.
It can see and change that page's DOM. It cannot see the page's own JavaScript,
and the page cannot see it. It has no Node, no `require`, no access to the
profile, the tab set or the browser's bridge, and it can only reach the network
as the page it is running in already could.

A plugin's own pages get a deliberately smaller bridge than the browser's own:
navigate, open a cloud, read the theme, read where the clouds have been. No
settings, no passwords, no history, no plugin management.

## What leaves the machine

Only what you browse to. Stratus has no telemetry, no crash reporting, no update
check and no accounts.

Two things reach out on your behalf and are worth naming:

- **Favicons.** The new tab page and the History page fetch `/favicon.ico` from
  the sites they list, which tells those sites you looked at a page listing them.
- **Search.** Typing something that is not an address sends it to whichever
  engine is set in Settings, as any browser does.

The live preview in the address bar fetches the page you are about to open, once
typing settles — the same request pressing Enter would make, made slightly
earlier.
