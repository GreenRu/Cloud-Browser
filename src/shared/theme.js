'use strict';

/**
 * Wearing a theme.
 *
 * A theme is one of the two built-in palettes, and - when a plugin is offering
 * one - a set of variables laid over the top of it. The base decides everything
 * the stylesheets do not name explicitly; the variables replace the colours
 * that are named.
 *
 * Applied the same way in the chrome and in the browser's own pages, so a theme
 * that only fills in half its palette still leaves a browser you can read.
 */

(function () {
  let applied = [];

  /**
   * @param {{ base?: string, variables?: Record<string, string> }} theme
   */
  function apply(theme) {
    const root = document.documentElement;
    const payload = typeof theme === 'string' ? { base: theme } : (theme || {});

    root.dataset.theme = payload.base === 'night' ? 'night' : 'day';

    // Clear what the last theme set before setting this one, or a variable it
    // dropped would linger.
    for (const name of applied) root.style.removeProperty(name);
    applied = [];

    const vars = payload.variables || {};
    for (const [name, value] of Object.entries(vars)) {
      if (!/^--[a-z0-9-]{1,40}$/i.test(name)) continue;
      if (typeof value !== 'string' || /[{};]/.test(value)) continue;
      root.style.setProperty(name, value);
      applied.push(name);
    }
  }

  window.SkyTheme = { apply };
})();
