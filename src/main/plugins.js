'use strict';

const fs = require('fs');
const path = require('path');
const { app } = require('electron');

/**
 * The plugin host.
 *
 * A plugin is a folder with a `plugin.json` manifest beside whatever files it
 * names. Manifests are declarative: a plugin says what it wants applied and
 * where, and the browser applies it. There is no plugin code in the main
 * process at all.
 *
 * That is the whole of the security model, and it is deliberate. Plugin
 * JavaScript runs only inside a page, in an isolated world, where it can see
 * the DOM and nothing else - not Node, not the IPC bridge, not the page's own
 * scripts. A plugin cannot open a window, read the profile, or reach the
 * network except as the page it is running in already could.
 *
 * Plugins are read from two places: the ones shipped with the browser, and the
 * ones in the profile directory, which is where anything installed goes. A
 * profile plugin with the same id as a bundled one replaces it.
 */

/** Everything a manifest may ask for. Anything else is ignored. */
const FIELDS = ['id', 'name', 'version', 'description', 'author', 'homepage',
  'shortcuts', 'commands', 'styles', 'scripts', 'pages', 'themes', 'toolbar'];

const MAX_FILE = 512 * 1024;   // a stylesheet or script this big is a mistake
const ID = /^[a-z][a-z0-9-]{1,39}$/;

/** Chrome-style match patterns, in the small subset that is actually useful. */
function patternToRegExp(pattern) {
  if (typeof pattern !== 'string' || !pattern) return null;
  if (pattern === '<all_urls>') return /^https?:\/\//i;

  const parts = /^(\*|https?):\/\/([^/]+)(\/.*)$/.exec(pattern);
  if (!parts) return null;
  const [, scheme, host, rest] = parts;

  const esc = (text) => text.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  const hostPart = host === '*'
    ? '[^/]+'
    : host.startsWith('*.')
      ? `(?:[^/]+\\.)?${esc(host.slice(2))}`
      : esc(host);

  return new RegExp(
    `^${scheme === '*' ? 'https?' : scheme}://${hostPart}${esc(rest).replace(/\*/g, '.*')}$`,
    'i'
  );
}

/** `#rrggbb` at an opacity, as something CSS will take. */
function withAlpha(color, alpha) {
  const hex = /^#([0-9a-f]{6})$/i.exec(String(color).trim());
  if (!hex || !Number.isFinite(alpha)) return String(color);
  const n = parseInt(hex[1], 16);
  const a = Math.min(1, Math.max(0, alpha));
  // eslint-disable-next-line no-bitwise
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** A path inside the plugin's own folder, or null if it tries to leave it. */
function safeJoin(root, relative) {
  if (typeof relative !== 'string' || !relative) return null;
  const full = path.resolve(root, relative);
  const inside = path.relative(root, full);
  if (inside.startsWith('..') || path.isAbsolute(inside)) return null;
  return full;
}

class PluginHost {
  constructor(store, { bundled } = {}) {
    this.store = store;
    this.dirs = [
      bundled || path.join(__dirname, '..', '..', 'plugins'),
      path.join(app.getPath('userData'), 'plugins')
    ];
    /** @type {Map<string, object>} loaded manifests, by id */
    this.plugins = new Map();
    /** Things that would not load, kept so the settings page can say why. */
    this.problems = [];
    this.load();
  }

  // --- loading ---------------------------------------------------------------

  load() {
    this.plugins = new Map();
    this.problems = [];

    for (const dir of this.dirs) {
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;   // a directory that is not there is not a problem
      }

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const root = path.join(dir, entry.name);
        try {
          const plugin = this._read(root);
          // A profile plugin replaces a bundled one with the same id.
          this.plugins.set(plugin.id, plugin);
        } catch (err) {
          this.problems.push({ path: root, error: String(err.message || err) });
        }
      }
    }

    return this.plugins.size;
  }

  _read(root) {
    const manifest = readJson(path.join(root, 'plugin.json'));
    const plugin = { root };

    for (const field of FIELDS) {
      if (manifest[field] !== undefined) plugin[field] = manifest[field];
    }

    if (!ID.test(String(plugin.id || ''))) {
      throw new Error('id must be lowercase letters, digits and dashes');
    }
    if (!plugin.name) plugin.name = plugin.id;
    plugin.version = String(plugin.version || '0.0.0');

    plugin.shortcuts = this._readShortcuts(plugin.shortcuts);
    plugin.commands = this._readCommands(plugin.commands);
    plugin.styles = this._readInjections(root, plugin.styles, 'css');
    plugin.scripts = this._readInjections(root, plugin.scripts, 'js');
    plugin.pages = this._readPages(root, plugin.pages, plugin.id);
    plugin.themes = this._readThemes(plugin.themes, plugin.id);
    plugin.toolbar = this._readToolbar(plugin.toolbar, plugin.id);

    return plugin;
  }

  /**
   * Buttons a plugin puts in the toolbar.
   *
   * The icon is described rather than drawn: a list of path outlines and circle
   * centres, which the chrome turns into an SVG. A plugin never hands the
   * browser markup, so there is nothing to sanitise and nothing to get wrong.
   *
   * `after` names the built-in button to sit behind, which is how a plugin asks
   * for a place rather than a pixel.
   */
  _readToolbar(input, pluginId) {
    if (!Array.isArray(input)) return [];
    const anchors = new Set(['back', 'forward', 'reload', 'home', 'find-open', 'settings']);

    return input
      .filter((b) => b && typeof b.id === 'string' && typeof b.label === 'string')
      .slice(0, 4)
      .map((b) => ({
        id: `${pluginId}:${b.id.slice(0, 40)}`,
        plugin: pluginId,
        label: b.label.slice(0, 60),
        after: anchors.has(b.after) ? b.after : 'forward',
        opens: typeof b.opens === 'string' && b.opens.startsWith(`stratus://${pluginId}`)
          ? b.opens
          : null,
        icon: this._readIcon(b.icon)
      }))
      .filter((b) => b.opens);
  }

  _readIcon(input) {
    const icon = { paths: [], circles: [] };
    if (!input || typeof input !== 'object') return icon;

    for (const d of (Array.isArray(input.paths) ? input.paths : []).slice(0, 8)) {
      // Path data only: digits, spaces and the letters SVG uses for commands.
      if (typeof d === 'string' && d.length <= 400 && /^[MmLlHhVvCcSsQqTtAaZz0-9,.\s-]+$/.test(d)) {
        icon.paths.push(d);
      }
    }
    for (const c of (Array.isArray(input.circles) ? input.circles : []).slice(0, 8)) {
      if (Array.isArray(c) && c.length === 3 && c.every((n) => Number.isFinite(n))) {
        icon.circles.push(c.map(Number));
      }
    }
    return icon;
  }

  /**
   * Themes a plugin offers.
   *
   * A theme is a set of CSS variables for the browser's own surfaces, plus the
   * fields whose values fill them in. Declaring the fields alongside the theme
   * is what makes an editable theme possible without a line of plugin code:
   * the browser draws the controls, keeps the values, and resolves them.
   */
  _readThemes(input, pluginId) {
    if (!Array.isArray(input)) return [];
    const out = [];

    for (const theme of input.slice(0, 8)) {
      if (!theme || typeof theme !== 'object') continue;
      if (!/^[a-z][a-z0-9-]{0,39}$/.test(String(theme.id || ''))) continue;

      out.push({
        // Namespaced, so two plugins offering "custom" stay apart.
        id: `${pluginId}:${theme.id}`,
        localId: theme.id,
        plugin: pluginId,
        name: String(theme.name || theme.id).slice(0, 40),
        dark: typeof theme.dark === 'string' ? theme.dark : Boolean(theme.dark),
        variables: this._readVariables(theme.variables),
        pageVariables: this._readVariables(theme.pageVariables),
        fields: this._readFields(theme.fields)
      });
    }

    return out;
  }

  _readVariables(input) {
    const out = {};
    if (!input || typeof input !== 'object') return out;
    for (const [name, value] of Object.entries(input)) {
      if (!/^--[a-z0-9-]{1,40}$/i.test(name)) continue;
      if (typeof value !== 'string' || value.length > 120) continue;
      // No braces or semicolons: a variable is a value, not a place to smuggle
      // more stylesheet into.
      if (/[{};<>]/.test(value)) continue;
      out[name] = value;
    }
    return out;
  }

  _readFields(input) {
    if (!Array.isArray(input)) return [];
    const kinds = new Set(['color', 'toggle', 'text']);
    return input
      .filter((f) => f && typeof f.id === 'string' && kinds.has(f.type))
      .slice(0, 80)
      .map((f) => ({
        id: f.id.slice(0, 40),
        label: String(f.label || f.id).slice(0, 60),
        type: f.type,
        group: String(f.group || '').slice(0, 40),
        default: f.type === 'toggle' ? Boolean(f.default) : String(f.default ?? '').slice(0, 60)
      }));
  }

  _readShortcuts(input) {
    const out = {};
    if (!input || typeof input !== 'object') return out;
    for (const [key, template] of Object.entries(input)) {
      if (!/^[a-z0-9]{1,12}$/i.test(key)) continue;
      if (typeof template !== 'string' || !template.includes('%s')) continue;
      if (!/^https?:\/\//i.test(template)) continue;
      out[key.toLowerCase()] = template;
    }
    return out;
  }

  _readCommands(input) {
    if (!Array.isArray(input)) return [];
    return input
      .filter((c) => c && typeof c.id === 'string' && typeof c.label === 'string')
      .slice(0, 12)
      .map((c) => ({
        id: c.id.slice(0, 40),
        label: c.label.slice(0, 60),
        accelerator: typeof c.accelerator === 'string' ? c.accelerator : null
      }));
  }

  /** Read the files now, so a page load never waits on the disk. */
  _readInjections(root, input, kind) {
    if (!Array.isArray(input)) return [];
    const out = [];

    for (const rule of input.slice(0, 8)) {
      if (!rule || typeof rule !== 'object') continue;
      const file = safeJoin(root, rule[kind]);
      if (!file) continue;

      let source;
      try {
        const stat = fs.statSync(file);
        if (stat.size > MAX_FILE) throw new Error(`${rule[kind]} is too large`);
        source = fs.readFileSync(file, 'utf8');
      } catch (err) {
        throw new Error(String(err.message || err));
      }

      const patterns = (Array.isArray(rule.matches) ? rule.matches : ['<all_urls>'])
        .map(patternToRegExp)
        .filter(Boolean);
      if (!patterns.length) continue;

      out.push({ patterns, source, at: rule.at === 'start' ? 'start' : 'end' });
    }

    return out;
  }

  _readPages(root, input, id) {
    const out = {};
    if (!input || typeof input !== 'object') return out;
    for (const [alias, relative] of Object.entries(input)) {
      // A plugin may only claim pages under its own name.
      if (alias !== `stratus://${id}` && !alias.startsWith(`stratus://${id}/`)) continue;
      const file = safeJoin(root, relative);
      if (file && fs.existsSync(file)) out[alias] = file;
    }
    return out;
  }

  // --- what the browser asks it for -----------------------------------------

  /**
   * Which plugins are switched on.
   *
   * Kept as the list of what is *on* rather than what is off, so a plugin does
   * nothing until it is asked to. Dropping a folder into the plugins directory
   * makes it available, not active - including the ones the browser ships with.
   */
  get enabled() {
    const list = this.store.get('enabledPlugins');
    return new Set(Array.isArray(list) ? list : []);
  }

  /** Every plugin that is loaded and switched on. */
  get active() {
    const on = this.enabled;
    return [...this.plugins.values()].filter((p) => on.has(p.id));
  }

  setEnabled(id, on) {
    if (!this.plugins.has(id)) return false;
    const list = this.enabled;
    if (on) list.add(id);
    else list.delete(id);
    this.store.set('enabledPlugins', [...list]);
    return true;
  }

  /** For the settings page: what is installed, and what would not load. */
  list() {
    const on = this.enabled;
    return {
      plugins: [...this.plugins.values()].map((p) => ({
        id: p.id,
        name: p.name,
        version: p.version,
        description: p.description || '',
        author: p.author || '',
        homepage: p.homepage || '',
        enabled: on.has(p.id),
        root: p.root,
        counts: {
          shortcuts: Object.keys(p.shortcuts).length,
          commands: p.commands.length,
          styles: p.styles.length,
          scripts: p.scripts.length,
          pages: Object.keys(p.pages).length,
          themes: p.themes.length,
          toolbar: p.toolbar.length
        }
      })),
      problems: this.problems,
      directory: this.dirs[this.dirs.length - 1]
    };
  }

  /** Search keywords contributed by plugins. The user's own always win. */
  shortcuts() {
    const out = {};
    for (const plugin of this.active) Object.assign(out, plugin.shortcuts);
    return out;
  }

  /** Toolbar buttons from the plugins that are switched on. */
  toolbar() {
    return this.active.flatMap((plugin) => plugin.toolbar);
  }

  // --- themes ----------------------------------------------------------------

  /** Every theme on offer from the plugins that are switched on. */
  themes() {
    return this.active.flatMap((plugin) => plugin.themes);
  }

  theme(id) {
    return this.themes().find((t) => t.id === id) || null;
  }

  /** What the user has set this theme's fields to, defaults filling the gaps. */
  themeValues(id) {
    const theme = this.theme(id);
    if (!theme) return {};

    const saved = this.store.get('pluginThemeValues') || {};
    const mine = saved[id] || {};
    const out = {};
    for (const field of theme.fields) {
      out[field.id] = Object.prototype.hasOwnProperty.call(mine, field.id)
        ? mine[field.id]
        : field.default;
    }
    return out;
  }

  setThemeValue(id, fieldId, value) {
    const theme = this.theme(id);
    const field = theme && theme.fields.find((f) => f.id === fieldId);
    if (!field) return false;

    const clean = field.type === 'toggle' ? Boolean(value) : String(value).slice(0, 60);
    if (field.type === 'color' && !/^#[0-9a-f]{3,8}$/i.test(clean)) return false;
    if (/[{};<>]/.test(String(clean))) return false;

    const saved = { ...(this.store.get('pluginThemeValues') || {}) };
    saved[id] = { ...(saved[id] || {}), [fieldId]: clean };
    this.store.set('pluginThemeValues', saved);
    return true;
  }

  /**
   * A theme, ready to apply: the variables with every `@field` reference
   * filled in, and whether it wants websites in their dark clothes.
   *
   * `@field` takes that field's value. `@field 0.5` takes its colour at that
   * opacity, which is how a palette of plain colour pickers can still describe
   * the translucent surfaces the interface is built from.
   */
  themeVars(id) {
    const theme = this.theme(id);
    if (!theme) return null;

    const values = this.themeValues(id);
    const resolve = (raw) => {
      const ref = /^@([a-z0-9-]+)(?:\s+([0-9.]+))?$/i.exec(raw);
      if (!ref) return raw;
      const value = values[ref[1]];
      if (value === undefined) return null;
      if (ref[2] === undefined) return String(value);
      return withAlpha(String(value), Number(ref[2]));
    };

    const fill = (vars) => {
      const out = {};
      for (const [name, raw] of Object.entries(vars)) {
        const value = resolve(raw);
        if (value !== null && value !== '') out[name] = value;
      }
      return out;
    };

    return {
      id: theme.id,
      name: theme.name,
      plugin: theme.plugin,
      // `dark` may be a field reference, which is how a theme lets you decide
      // whether websites should be asked for their dark clothes.
      dark: typeof theme.dark === 'string'
        ? Boolean(values[theme.dark.replace(/^@/, '')])
        : Boolean(theme.dark),
      variables: fill(theme.variables),
      pageVariables: fill(theme.pageVariables)
    };
  }

  /** Extra `stratus://` aliases. */
  pages() {
    const out = {};
    for (const plugin of this.active) Object.assign(out, plugin.pages);
    return out;
  }

  /** Commands to put in the menu, each tagged with the plugin that owns it. */
  commands() {
    return this.active.flatMap((plugin) =>
      plugin.commands.map((command) => ({ ...command, plugin: plugin.id, pluginName: plugin.name }))
    );
  }

  /** The stylesheets and scripts that apply to one URL. */
  injectionsFor(url) {
    const styles = [];
    const scripts = [];
    if (!/^https?:\/\//i.test(String(url))) return { styles, scripts };

    for (const plugin of this.active) {
      for (const rule of plugin.styles) {
        if (rule.patterns.some((re) => re.test(url))) styles.push(rule);
      }
      for (const rule of plugin.scripts) {
        if (rule.patterns.some((re) => re.test(url))) scripts.push({ ...rule, plugin: plugin.id });
      }
    }

    return { styles, scripts };
  }
}

module.exports = { PluginHost, patternToRegExp, withAlpha };
