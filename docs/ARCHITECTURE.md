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
| One of the browser's own | `window.cloudPage` | navigate, settings, history, bookmarks, passwords, plugins |
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
└── the previews                 one per thing that can ask for one
```

The consequence catches everyone once: **the chrome cannot draw over a page.**
Anything the sidebar renders inside the page area is hidden the moment a tab is
open. Two things follow from it:

- The card around the address bar's preview is its own view
  (`src/pages/bubble.html`). It was HTML in the chrome for a while, and was
  invisible the entire time — every measurement correct, nothing on screen.
- The grip on the seam between merged panes *is* chrome HTML, and works,
  because the seam is the one part of the page area no view covers.
- The menu on a cloud is native, and can be, because the strip is chrome too.
  The new tab page's menu on a shortcut cloud is HTML instead - that one is
  drawn by a page, which cannot ask the browser to open a menu for it.

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
  expensive assumption to get wrong.
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
