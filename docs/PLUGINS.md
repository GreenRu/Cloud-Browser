# Writing a plugin

A plugin is a folder with a `plugin.json` manifest beside whatever files it
names. Manifests are **declarative**: a plugin says what it wants applied and
where, and the browser applies it.

**There is no plugin code in the main process at all**, and there is not going
to be. That is the whole security model — see
[What a plugin cannot do](#what-a-plugin-cannot-do).

The full field-by-field reference lives beside the plugins themselves, in
[../plugins/README.md](../plugins/README.md). This page is the tour.

- [Where plugins live](#where-plugins-live)
- [The three bundled ones](#the-three-bundled-ones)
- [What a plugin can contribute](#what-a-plugin-can-contribute)
- [A plugin's own pages](#a-plugins-own-pages)
- [What a plugin cannot do](#what-a-plugin-cannot-do)
- [When something is wrong](#when-something-is-wrong)

## Where plugins live

Two folders are read:

- `plugins/` in the repository — the ones that ship with the browser.
- `plugins/` inside the profile directory — where anything you install goes.
  **Settings → Plugins** has a button that opens it.

A plugin in the profile replaces a bundled one with the same id.

**Everything is switched off until you switch it on.** The store keeps the list
of what is *on*, so dropping a folder in makes a plugin available, not active.
Settings has a switch for each, and a reload button for when you have just
edited one.

## The three bundled ones

Copy any of them as a starting point.

| Folder | Shows how to |
| --- | --- |
| `plugins/quiet-reader/` | Inject a stylesheet and a script into pages, add a search keyword, and take a command from the menu |
| `plugins/own-theme/` | Offer an editable theme — 39 colour controls and a toggle, with no plugin code at all |
| `plugins/page-timeline/` | Add a toolbar button and a page of its own, and read browser data through the plugin bridge |

## What a plugin can contribute

```json
{
  "id": "my-plugin",
  "name": "My Plugin",
  "version": "1.0.0",
  "description": "One line about what it does.",

  "shortcuts": { "mp": "https://example.com/search?q=%s" },
  "commands":  [{ "id": "toggle", "label": "Toggle it", "accelerator": "CommandOrControl+Alt+M" }],
  "styles":    [{ "matches": ["*://*.example.com/*"], "css": "skin.css" }],
  "scripts":   [{ "matches": ["<all_urls>"], "js": "content.js" }],
  "pages":     { "stratus://my-plugin": "page.html" },
  "toolbar":   [{ "id": "open", "label": "Open it", "after": "back",
                  "opens": "stratus://my-plugin",
                  "icon": { "paths": ["M5 12h14"], "circles": [[4, 12, 1.6]] } }],
  "themes":    [{ "id": "custom", "name": "Custom", "dark": "@dark-sites",
                  "variables": { "--sky-top": "@sky" },
                  "fields": [{ "id": "sky", "label": "Sky", "type": "color", "default": "#74b1e5" }] }]
}
```

**Search keywords.** Type `mp something` and `%s` is where the query lands. A
keyword you have set yourself always beats a plugin's.

**Commands** appear under the Plugins menu and can take an accelerator. Choosing
one sends an event to your scripts in the page in front:

```js
window.addEventListener('stratus:command', (event) => {
  const { plugin, command } = event.detail;
  if (plugin === 'my-plugin' && command === 'toggle') doTheThing();
});
```

**Styles and scripts** apply to pages that match. Patterns are Chrome's, in the
useful subset: `<all_urls>`, and `scheme://host/path` where the scheme may be
`*`, the host may be `*` or `*.example.com`, and `*` in the path matches
anything. Neither is *ever* applied to the browser's own pages.

**Pages** register `stratus://` addresses. A plugin may only claim its own name
or something beneath it.

**Toolbar buttons** name the built-in button to sit behind — `back`, `forward`,
`reload`, `home`, `find-open` or `settings` — so a plugin asks for a place
rather than a pixel, and open one of the plugin's own pages. The icon is
*described*, not drawn: outlines and circle centres on a 24×24 grid, which the
browser turns into an SVG. A plugin never hands the browser markup, so there is
nothing to sanitise.

**Themes** contribute a palette, and their `fields` are what make one *editable*
rather than fixed: Settings draws a control for each, keeps the values, and
fills them into the variables. `@field` is that field's value; `@field 0.74` is
its colour at that opacity, which is how a palette of plain colour pickers can
describe translucent surfaces. A theme sits on Day or Night underneath and only
replaces the colours it names.

## A plugin's own pages

A page registered under `pages` gets `window.cloudPlugin`:

```js
cloudPlugin.navigate(url)             // go somewhere in this cloud
cloudPlugin.openTab(url, background)  // open a new one
cloudPlugin.getState()                // what the browser is showing, and the theme
cloudPlugin.timeline()                // where every cloud has been, as trees
cloudPlugin.onChange(fn)              // something changed - ask for what you want
cloudPlugin.onTheme(fn)               // the theme changed
```

`onChange` carries **no payload**. A page that wants to know something asks for
exactly the thing it is allowed to have, rather than being handed the browser's
state whether it wanted it or not.

## What a plugin cannot do

Your JavaScript runs inside a page, in an isolated world. It can see and change
the DOM. It **cannot**:

- see the page's own JavaScript, or be seen by it
- reach Node, `require`, or the file system
- reach the profile: no settings, no passwords, no history, no bookmarks
- reach the browser's own pages — no stylesheet or script is ever applied to them
- open a window, or run anything in the main process
- reach the network except as the page it is running in already could

A plugin dresses a page. It does not run the browser.

## When something is wrong

A manifest that will not parse, an id that is not one, or a file a plugin has no
right to read does not stop the browser or the other plugins: that folder is
skipped and the reason is listed in **Settings → Plugins**.

Stylesheets and scripts are read from disk when plugins load, so a page never
waits on the file system, and anything over 512 KB is refused. A script that
throws is caught and logged to that page's console with the plugin's id, and
everything else carries on.
