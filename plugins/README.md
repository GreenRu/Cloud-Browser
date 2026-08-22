# Plugins

Reserved for the plugin system. Nothing loads from this folder yet — it is
kept in the repository so the directory exists once the host lands.

## Intended shape

A plugin is a folder here with a `plugin.json` manifest and an entry script:

```
plugins/
  my-plugin/
    plugin.json
    main.js
```

The pieces it will hook into already exist:

- `src/main/shell.js` owns the tab set and broadcasts `shell:state`, which is
  the natural place to expose a read-only view of tabs to plugins.
- `src/main/menu.js` builds both the shortcut table and the toolbar menu, so
  plugins can contribute commands and accelerators in one place.
- `src/main/store.js` takes arbitrary keys, so plugin settings can persist
  without a new storage layer.
- `src/main/urls.js` maps `cloud://` aliases to pages, which is how a plugin
  would register its own settings page.

Plugin code must not get the renderer's IPC bridge or Node access in a web
page; the boundary in `src/preload/` is deliberate and should stay that way.
