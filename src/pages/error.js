'use strict';

const bridge = window.cloudPage;
const params = new URLSearchParams(location.search);
const failedUrl = params.get('url') || '';
const code = params.get('code') || '';

/** Chromium net error names, translated into something a person can act on. */
const FRIENDLY = {
  '-105': 'That address could not be found. Check the spelling of the site name.',
  '-106': 'You appear to be offline. Check your network connection.',
  '-109': 'The site is unreachable right now.',
  '-118': 'The site took too long to respond.',
  '-201': 'The site’s security certificate is not trusted.',
  '-202': 'The site’s security certificate is not valid for this address.',
  '-501': 'The connection is not private.'
};

document.getElementById('description').textContent =
  FRIENDLY[code] || params.get('description') || 'The page could not be reached.';
document.getElementById('url').textContent = failedUrl;
document.getElementById('code').textContent = code ? `Error ${code}` : '';

document.getElementById('retry').addEventListener('click', () => {
  if (failedUrl && bridge) bridge.navigate(failedUrl);
  else location.reload();
});

document.getElementById('home').addEventListener('click', () => {
  bridge?.navigate('stratus://newtab');
});

if (bridge) {
  bridge
    .getState()
    .then((state) => {
      window.SkyTheme.apply({ base: state.themeBase, variables: state.pageThemeVars });
    })
    .catch(() => {});
}

// Follow the browser theme while the page is open, not just at load.
bridge?.onTheme?.((theme) => {
  window.SkyTheme.apply(theme);
});
