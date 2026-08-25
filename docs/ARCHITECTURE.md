# Architecture

How Stratus is put together, and why the awkward parts are the shape they are.

- [The three kinds of code](#the-three-kinds-of-code)
- [Views, and the order they stack in](#views-and-the-order-they-stack-in)
- [Positioning the page](#positioning-the-page)
- [Merged clouds](#merged-clouds)
- [The preview bubble](#the-preview-bubble)
- [Focus](#focus)
- [State and IPC](#state-and-ipc)
- [Themes](#themes)
- [Where a page's trail is kept](#where-a-pages-trail-is-kept)
- [Plugins](#plugins)
- [Things worth knowing before changing any of it](#things-worth-knowing-before-changing-any-of-it)

## The three kinds of code

**Main** (`src/main/`) owns everything: the window, the tabs, the profile, the
plugins. Nothing else can open a page, read a file or reach the network on the
browser's behalf.

**The chrome renderer** (`src/renderer/`) draws the sidebar, the address bar and
the clouds. It holds no browsing state of its own — it is handed a snapshot and
sends back intents.

**Pages** are everything shown in the page area: web pages, the browser's own
pages (`src/pages/`), and pages belonging to plugins. Each gets a preload from
`src/preload/`, and what it is decides which bridge it gets:

| Page | Bridge | Can do |
| --- | --- | --- |
| A website | none | nothing beyond being a page |
| One of the browser's own | `window.cloudPage` | navigate, settings, history, droplets, passwords, plugins |
| A plugin's own | `window.cloudPlugin` | navigate, open a cloud, read the theme, read the trails |

`contextIsolation` is on and `nodeIntegration` off everywhere, every bridge
channel is enumerated by hand, and web pages run sandboxed in a persistent
session partition of their own.

The preload tells a plugin page from any other local file using the plugin
directories the main process passes it as an argument — not by guessing from the
path, so a local `.html` you open yourself gets nothing.

## Views, and the order they stack in

A `WebContentsView` is a **native child of the window**, not part of the UI
document. Several are stacked, and the order is deliberate:

```
window
├── the chrome renderer          the sidebar, drawn underneath everything
├── the page views               one per pane of the active cloud
├── the preview card             the frame around the address bar's preview
├── the previews                 one per thing that can ask for one
└── the menu view                over all of it, wherever it is opened
```

The consequence catches everyone once: **the chrome cannot draw over a page.**
Anything the sidebar renders inside the page area is hidden the moment a tab is
open. Two things follow from it:

- The card around the address bar's preview is its own view
  (`src/pages/bubble.html`). It was HTML in the chrome for a while, and was
  invisible the entire time — every measurement correct, nothing on screen.
- The grip on the seam between merged panes *is* chrome HTML, and works,
  because the seam is the one part of the page area no view covers.
- The menu is a view too (`src/pages/cloud-menu.html`) - one view, shown for a
  cloud and for a droplet alike. It was chrome
  HTML first, on the reasoning that the strip is chrome - but a menu opened on a
  cloud is wider than the sidebar, so its right-hand edge was cut off by the
  page. What is *on* it is decided in the main process, where the state is -
  which cloud, what is picked, what has been closed - and sent to that view as a
  description it turns into buttons. It sends back the name of whatever was
  chosen, and nothing there is trusted but the name. It is drawn as a cloud, by
  the same lobe generator the strip uses, and the view is padded so the lobes
  have somewhere to rise into rather than being clipped at its edge.

  The droplet bar hit the same wall for the same reason. The bar itself is fine -
  it is chrome, sitting *above* the page rather than over it - but a menu opened
  from it hangs down, straight into the page. It goes through the same view,
  which is why `_showMenu` takes what the menu is for (`{ kind, id }`) and keeps
  it in the main process: the view is handed labels and hands back a name, and
  the browser alone decides what that name means. A third kind of menu is a
  `dropletMenu` and a `runDropletMenu`, and nothing else.

Activating a cloud adds its views, which puts them on top, so the card and the
previews are lifted back afterwards — frame first, previews over it.

## Positioning the page

The renderer keeps an empty `.stage` element exactly where the page belongs and
reports its rect as **insets from the window edges**; the main process turns
those back into view bounds. Opening the find bar or dragging the sidebar
therefore moves the page automatically, with no hard-coded chrome height
anywhere.

Full screen zeroes the insets rather than special-casing the layout.

## Merged clouds

A merged cloud is one entry in the strip showing several pages. The host tab
holds the others as whole `Tab` objects in `extraPanes` — not just their views —
which is what lets them keep updating their own titles and favicons, and be
handed back intact when the cloud is split.

The panes share the width by fractions, dragged at the seam. Each fraction has a
floor, so a pane can be made small but never nothing. Merged panes square off
their corners: a native view can only be rounded on all four corners or none,
and rounding them opens a bulge in the seam where two corners face each other.

Anything a pane asks for is answered *for that pane* — a link followed in the
middle pane opens there, not in the host. Which pane asked comes from the view
the message arrived on, never from anything the page says about itself.

## The preview bubble

While there is something in a search bar, a card hangs off it showing the page
that pressing Enter would open — rendered live, not described.

The card is only a frame. Its interior rect is reported to the main process,
which parks a real view over it. Pressing it grows that view into the place it
belongs — the whole page area for the address bar, or one pane for a pane's own
search bar — and hands the page over.

There is **one preview per thing that can ask for one**, keyed by the webContents
that owns the keyboard while its bubble is up. Three panes of a merged cloud can
be searched at once without fighting over a single view.

Loads are coalesced: the destination updates on every keystroke, but the page
itself is only fetched once typing settles, because attaching a view moves
native focus.

## Focus

A view takes native keyboard focus from several directions — being shown, a load
committing, the page calling `focus()` itself — and every one of them sends the
next keystrokes somewhere unintended.

Rather than chase each cause, focus is bounced back whenever it lands on a
preview, to *that preview's own owner*. Returning it from inside the `focus`
event does not work: it is re-entrant and gets undone, so it is deferred out of
the focus change and repeated shortly after.

Moving DOM focus inside the chrome is likewise not enough on its own — the page
view holds native focus, so `focusChrome()` focuses the chrome's web contents
first and then asks it to focus the control.

## State and IPC

The chrome gets `shell:state`, a full snapshot, because it draws all of it.

Pages get `cloud:changed` — **a knock at the door with nothing in it**. Anything
that wants to know more asks for exactly what it is allowed to have. Nothing
about the other clouds leaks into a page that never asked.

Intents go back the other way over an explicitly enumerated channel list. The
renderer never mutates browsing state directly.

## Flights

A download is called a flight, because it arrives. `src/main/flights.js` owns
every live one: the renderer names a flight by its id and asks for something to
be done to it, and never holds a `DownloadItem` or names a path.

Two things about the interface are decided by the law above, not by taste.

**The meteor can only fly where the chrome is.** A file on its way down crosses
the sky as a meteor, and the sky it crosses is the strip above the page and the
sidebar column - the two parts of the window a page view does not cover. The
path is measured from where the page actually is (`meteorPath()` in the
renderer) and rebuilt whenever that moves, because a meteor routed across the
middle of the window would be behind the page and simply not there. The suite
asserts that no point on the path lands inside the page's rectangle.

**The panel is its own view.** It hangs down from a button in the sidebar,
straight into the page area, so it cannot be chrome. Unlike the cloud menu it
stays up while things change, so it is handed the whole state whenever anything
moves rather than once when it opens - and it is placed only after it has
measured itself and said how big it turned out.

One thing about it was learned the hard way: **a panel that hides on blur hides
when a page finishes loading**, because the page takes focus back the moment it
does. Blur within the first fraction of a second after opening is ignored, or
the panel appears not to open at all.

Progress is reported at most twice a second. `overall()` returns one fraction
for the taskbar - or `2`, which Electron reads as an indeterminate bar, when a
server never said how big the file was.

## Secrets: logins and cards

Both stores follow one rule: every secret is encrypted with Electron's
`safeStorage`, which delegates to the OS keystore, and **if the platform cannot
encrypt then saving is refused** rather than falling back to plaintext. Only what
a list has to show stays readable - a username, a card's last four digits.

Filling follows one rule too: **the page never says who it is.** The renderer
sends the submitted values, or a bare "someone put the cursor in a card field",
and the main process reads the origin from the sending tab's own URL. Nothing is
filled in an iframe, on one of the browser's own pages, or when several entries
match - with two saved there is no way to know which is meant, and guessing is
worse than asking.

`src/main/cards.js` carries the one setting with a memory. Keeping the code on
the back of a card is off by default; switching it off destroys every code held
*and writes down when*. A code is then only ever offered if it was saved after
that moment, so one that outlived the wipe - an older file, a restored backup -
is not offered either. It is enforced by the timestamp rather than only by the
deletion because a deletion can be undone by a backup and a timestamp cannot.

## Bringing things over

`src/main/import.js` reads another browser's bookmarks straight out of its own
files: Chromium's `Bookmarks` JSON, and Firefox's `bookmarkbackups/*.jsonlz4`,
whose mozLz4 framing is decoded in about forty lines rather than by taking on a
dependency.

Passwords deliberately are not read that way. They are sealed to the browser that
saved them, and prising them out would mean doing what a password stealer does.
They come in from a CSV the user exported, as do cards. Header names differ
between browsers, so `COLUMNS` maps several spellings onto one meaning.

## Themes

A theme is one of two built-in palettes, plus — when a plugin offers one — a set
of CSS variables laid over the top. `src/shared/theme.js` applies both, in the
chrome and in the browser's own pages, so a theme that fills in half its palette
still leaves a browser you can read.

The window controls are drawn by the system and need a colour rather than a
variable, so the titlebar overlay takes the theme's own sky where it gives one.

## Where a page's trail is kept

Chromium keeps history as a line: go back three pages, follow a different link,
and the three ahead of you are gone. What actually happened is a fork.

Each `Tab` also records a **tree** — every page keeps the page it was opened
from. A step back moves where the cloud *is* without adding anything; going
somewhere else from there hangs a new branch off that point. Which is which is
decided by comparing Chromium's own active index against a map of the nodes
already recorded at each index.

The Page Timeline plugin draws it. Nothing else depends on it.

## Plugins

`src/main/plugins.js` reads manifests, applies what they declare, and holds the
line that **no plugin code runs in the main process**. Plugin JavaScript runs
only inside a page, in an isolated world, where it can see the DOM and nothing
else.

Plugins are opt-in: the store keeps the list of what is *on*, so dropping a
folder into the plugins directory makes it available, not active.

See [PLUGINS.md](PLUGINS.md) for the manifest, and
[../plugins/README.md](../plugins/README.md) for the reference kept beside the
plugins themselves.

## Things worth knowing before changing any of it

Each of these cost real time to find. [../PLAN.md](../PLAN.md) has the full list
with the evidence.

- **The chrome cannot draw over a page.** Covered above; it is the single most
  expensive assumption to get wrong, and it has now been got wrong twice - once
  for the preview card, once for the cloud menu, whose right-hand edge was cut
  off at the sidebar. `capturePage` on the renderer will not show it: that
  captures the renderer alone, so the missing part looks perfectly present.
  A screen capture is the only thing that tells you.
- **A filled animation outranks inline styles.** `.tab` carries
  `animation: cloud-in ... both`, and `both` keeps the last keyframe applying
  forever — silently beating every later attempt to set `transform` or `opacity`
  from script. Assert the *value* partway through, never just the duration.
- **Synthetic events do not exercise the real input path.** A dispatched
  `MouseEvent` skips the pointer path entirely, so a suite can pass green while
  real clicks do nothing. Pointer behaviour needs a real OS click.
- **An occluded window pauses its CSS animations and throttles its timers.** A
  stray Electron window left over from an earlier run will make timing
  assertions fail with nothing wrong in the code.
- **A suite that builds the shell by hand never boots the app.** Every suite
  constructs `BrowserShell` directly, so none of them runs `src/main/index.js`.
  Run `npx electron .` and read the output.
- **A hidden window never gives its document focus.** `show: false` is the
  obvious way to keep a suite out of the way, and anything depending on focus -
  `focusin`, `document.activeElement` - then quietly never happens.
- **One throw stops the rest of a loop.** Filling a form walks a list of fields,
  so an exception on the third leaves the first two filled and the rest empty,
  which reads exactly like "the last fields were not recognised". When *some* of
  a sequence worked, suspect a throw before suspecting the matching.
