# Plugins

A plugin is a folder with a `plugin.json` manifest beside whatever files it
names:

```
plugins/
  quiet-reader/
    plugin.json
    quiet.css
    reader.js
```

Stratus reads two folders: this one, for plugins shipped with the browser, and
`plugins/` inside the profile directory, which is where anything you install
goes. **Settings → Plugins** has a button that opens it, a switch for each
plugin, and a reload button for when you have just edited one. A plugin in the
profile replaces a bundled one with the same id.

**Everything is switched off until you switch it on**, including the plugins
that ship with the browser. Dropping a folder in makes a plugin available, not
active.

Three ship with the browser, and each is a working example to copy:

| Folder | Shows how to |
| --- | --- |
| `quiet-reader/` | Inject a stylesheet and a script, add a keyword, take a command |
| `own-theme/` | Offer an editable theme - 39 colour controls, no plugin code at all |
| `page-timeline/` | Add a toolbar button and a page, and read browser data |

## The manifest

Every field is optional except `id`, which must be lowercase letters, digits and
dashes.

```json
{
  "id": "my-plugin",
  "name": "My Plugin",
  "version": "1.0.0",
  "description": "One line about what it does.",
  "author": "you",
  "homepage": "https://example.com",

  "shortcuts": { "mp": "https://example.com/search?q=%s" },

  "commands": [
    { "id": "toggle", "label": "Toggle it", "accelerator": "CommandOrControl+Alt+M" }
  ],

  "styles": [
    { "matches": ["*://*.example.com/*"], "css": "skin.css" }
  ],

  "scripts": [
    { "matches": ["<all_urls>"], "js": "content.js" }
  ],

  "pages": { "stratus://my-plugin": "page.html" }
}
```

**shortcuts** are address bar keywords: type `mp something` and `%s` is where
the query lands. A keyword you have set yourself always beats a plugin's.

**commands** appear under the Plugins menu. Choosing one sends an event to your
scripts in the page in front - see below.

**styles** and **scripts** name files to apply to pages that match. Patterns are
Chrome's, in the useful subset: `<all_urls>`, and `scheme://host/path` where
the scheme may be `*`, the host may be `*` or `*.example.com`, and `*` in the
path matches anything. Neither is ever applied to the browser's own pages.

**themes** contribute a palette. Each one appears in the Theme dropdown in
Settings beside Day and Night, and while it is worn its `variables` are laid
over the browser's own colours and its `pageVariables` over the browser's pages:

```json
"themes": [{
  "id": "custom",
  "name": "Custom",
  "dark": "@dark-sites",
  "variables": { "--sky-top": "@sky-top", "--panel": "@panel 0.74" },
  "pageVariables": { "--card-solid": "@card" },
  "fields": [
    { "id": "sky-top", "label": "Sky, top", "group": "The sky", "type": "color", "default": "#74b1e5" },
    { "id": "panel", "label": "Panel", "group": "Text and controls", "type": "color", "default": "#ffffff" },
    { "id": "card", "label": "Card", "group": "Pages", "type": "color", "default": "#ffffff" },
    { "id": "dark-sites", "label": "Ask websites for their dark theme", "type": "toggle", "default": false }
  ]
}]
```

A theme's `fields` are what makes it *editable* rather than fixed: Settings
draws a control for each one, groups them by `group`, keeps the values, and
fills them into the variables. `@field` is that field's value; `@field 0.74` is
its colour at that opacity, which is how a palette of plain colour pickers can
still describe translucent surfaces. `dark` may be a field reference too - that
is the switch for whether websites are asked for their dark theme.

A theme is built on Day or Night depending on `dark`, and only replaces the
colours it names, so a half-finished palette still leaves a browser you can
read. Switching the plugin off falls back to Day.

`own-theme/` here is exactly this: one theme, every colour the interface uses,
and nothing else.

**toolbar** puts a button in the browser's toolbar:

```json
"toolbar": [{
  "id": "open",
  "label": "Page timeline",
  "after": "back",
  "opens": "stratus://my-plugin",
  "icon": {
    "paths": ["M5 12h4", "M13 12h6"],
    "circles": [[4, 12, 1.6], [20, 12, 1.4]]
  }
}]
```

`after` names the built-in button to sit behind - `back`, `forward`, `reload`,
`home`, `find-open` or `settings` - so a plugin asks for a place rather than a
pixel. `opens` must be one of the plugin's own pages. The icon is *described*,
not drawn: outlines and circles on a 24x24 grid, which the browser turns into an
SVG. A plugin never hands the browser markup, so there is nothing to sanitise.

**pages** register `stratus://` addresses. A plugin may only claim its own name
or something beneath it - `stratus://my-plugin` and `stratus://my-plugin/help`
are yours, `stratus://settings` is not.

## A plugin's own pages

A page registered under `pages` gets `window.cloudPlugin` - a smaller bridge
than the browser's own pages have:

```js
cloudPlugin.navigate(url)          // go somewhere in this cloud
cloudPlugin.openTab(url, background)
cloudPlugin.getState()             // what the browser is showing, and the theme
cloudPlugin.timeline()             // where every cloud has been, as trees
cloudPlugin.onChange(fn)           // something changed - ask for what you want
cloudPlugin.onTheme(fn)
```

There is deliberately nothing here that touches the profile: no settings, no
passwords, no history, no plugin management. `onChange` carries no payload -
a page that wants to know something asks for exactly the thing it is allowed to
have, rather than being handed the browser's state whether it wanted it or not.

`page-timeline/` here uses `timeline()` to draw where each cloud has been.

## What a plugin can and cannot do

Manifests are declarative: a plugin says what it wants applied and where, and
the browser applies it. **There is no plugin code in the main process at all.**

Your JavaScript runs inside the page, in an isolated world. It can see and
change the DOM. It cannot see the page's own JavaScript, and the page cannot see
it - neither can reach the other's variables. It has no Node, no `require`, no
access to the profile, the tab set, or the browser's IPC bridge, and it can only
reach the network as the page it is running in already could.

This is the whole security model and it is meant to stay that way. A plugin is
something that dresses a page, not something that runs the browser.

The one channel from the browser to a plugin is the command event:

```js
window.addEventListener('stratus:command', (event) => {
  const { plugin, command } = event.detail;
  if (plugin !== 'my-plugin') return;
  if (command === 'toggle') doTheThing();
});
```

## When something is wrong

A manifest that will not parse, an id that is not one, or a file a plugin has no
right to read does not stop the browser or the other plugins: that folder is
skipped and the reason is listed in Settings → Plugins. Stylesheets and scripts
are read from disk when plugins load, so a page never waits on the file system,
and anything over 512 KB is refused.

A script that throws is caught and logged to that page's console with the
plugin's id, and everything else carries on.
