'use strict';

const { Menu, shell } = require('electron');

/**
 * The application menu doubles as the keyboard-shortcut table: accelerators
 * registered here fire even while focus is inside a page's WebContentsView,
 * which a renderer-side keydown listener could never see.
 *
 * The bar itself is hidden on Windows/Linux (see BrowserShell), so this is
 * invisible plumbing rather than chrome the user has to look at.
 */
function buildAppMenu(getShell) {
  const withShell = (fn) => () => {
    const s = getShell();
    if (s && !s.window.isDestroyed()) fn(s);
  };

  const numberAccelerators = Array.from({ length: 9 }, (_, i) => ({
    label: `Tab ${i + 1}`,
    accelerator: `CommandOrControl+${i + 1}`,
    visible: false,
    click: withShell((s) => s.selectByIndex(i))
  }));

  const template = [
    {
      label: 'File',
      submenu: [
        {
          label: 'New Tab',
          accelerator: 'CommandOrControl+T',
          click: withShell((s) => s.newTab())
        },
        {
          label: 'Close Tab',
          accelerator: 'CommandOrControl+W',
          click: withShell((s) => s.activeId && s.closeTab(s.activeId))
        },
        { type: 'separator' },
        {
          label: 'Focus Address Bar',
          accelerator: 'CommandOrControl+L',
          click: withShell((s) => s.focusChrome('shell:focus-omnibox'))
        },
        {
          label: 'Focus Address Bar (Alt+D)',
          accelerator: 'Alt+D',
          visible: false,
          click: withShell((s) => s.focusChrome('shell:focus-omnibox'))
        },
        { type: 'separator' },
        {
          label: 'Settings',
          accelerator: 'CommandOrControl+,',
          click: withShell((s) => s.newTab('cloud://settings'))
        },
        { type: 'separator' },
        { role: 'quit', label: 'Exit' }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
        { type: 'separator' },
        {
          label: 'Find in Page',
          accelerator: 'CommandOrControl+F',
          click: withShell((s) => s.focusChrome('shell:open-find'))
        }
      ]
    },
    {
      label: 'View',
      submenu: [
        {
          label: 'Reload',
          accelerator: 'CommandOrControl+R',
          click: withShell((s) => s.activeTab?.reload())
        },
        {
          label: 'Hard Reload',
          accelerator: 'CommandOrControl+Shift+R',
          click: withShell((s) => s.activeTab?.reload(true))
        },
        { type: 'separator' },
        {
          // Electron rejects a bare "Plus" accelerator, so "=" is the binding
          // and the numpad key is registered alongside it.
          label: 'Zoom In',
          accelerator: 'CommandOrControl+=',
          click: withShell((s) => s.activeTab?.setZoom(0.5))
        },
        {
          label: 'Zoom In (numpad)',
          accelerator: 'CommandOrControl+numadd',
          visible: false,
          click: withShell((s) => s.activeTab?.setZoom(0.5))
        },
        {
          label: 'Zoom Out',
          accelerator: 'CommandOrControl+-',
          click: withShell((s) => s.activeTab?.setZoom(-0.5))
        },
        {
          label: 'Actual Size',
          accelerator: 'CommandOrControl+0',
          click: withShell((s) => s.activeTab?.setZoom(0))
        },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        {
          label: 'Toggle Developer Tools',
          accelerator: 'CommandOrControl+Shift+I',
          click: withShell((s) => s.activeTab?.webContents.toggleDevTools())
        },
        {
          label: 'Toggle Developer Tools (F12)',
          accelerator: 'F12',
          visible: false,
          click: withShell((s) => s.activeTab?.webContents.toggleDevTools())
        }
      ]
    },
    {
      label: 'History',
      submenu: [
        {
          label: 'Back',
          accelerator: 'Alt+Left',
          click: withShell((s) => s.activeTab?.goBack())
        },
        {
          label: 'Forward',
          accelerator: 'Alt+Right',
          click: withShell((s) => s.activeTab?.goForward())
        },
        {
          label: 'Home',
          accelerator: 'Alt+Home',
          click: withShell((s) => s.activeTab?.loadURL(s.store.get('homepage')))
        },
        { type: 'separator' },
        {
          label: 'Next Tab',
          accelerator: 'Control+Tab',
          click: withShell((s) => s.cycleTab(1))
        },
        {
          label: 'Previous Tab',
          accelerator: 'Control+Shift+Tab',
          click: withShell((s) => s.cycleTab(-1))
        },
        ...numberAccelerators,
        { type: 'separator' },
        {
          label: 'Show All History',
          accelerator: 'CommandOrControl+H',
          click: withShell((s) => s.newTab('cloud://history'))
        },
        {
          label: 'Show Bookmarks',
          accelerator: 'CommandOrControl+Shift+O',
          click: withShell((s) => s.newTab('cloud://bookmarks'))
        },
        {
          label: 'Bookmark This Page',
          accelerator: 'CommandOrControl+D',
          click: withShell((s) => {
            const tab = s.activeTab;
            if (!tab) return;
            s.store.toggleBookmark({ url: tab.url, title: tab.title });
            s._broadcast();
          })
        }
      ]
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'Cloud Browser on the Web',
          click: () => shell.openExternal('https://www.electronjs.org/docs/latest')
        }
      ]
    }
  ];

  return Menu.buildFromTemplate(template);
}

/** The "..." toolbar button. A native popup so it is never clipped by the chrome. */
function popupToolsMenu(shellRef, x, y) {
  const tab = shellRef.activeTab;
  const bookmarked = tab ? shellRef.store.isBookmarked(tab.url) : false;

  const menu = Menu.buildFromTemplate([
    { label: 'New tab', accelerator: 'Ctrl+T', click: () => shellRef.newTab() },
    { type: 'separator' },
    {
      label: bookmarked ? 'Remove bookmark' : 'Bookmark this page',
      accelerator: 'Ctrl+D',
      enabled: Boolean(tab),
      click: () => {
        shellRef.store.toggleBookmark({ url: tab.url, title: tab.title });
        shellRef._broadcast();
      }
    },
    { label: 'Bookmarks', accelerator: 'Ctrl+Shift+O', click: () => shellRef.newTab('cloud://bookmarks') },
    { label: 'History', accelerator: 'Ctrl+H', click: () => shellRef.newTab('cloud://history') },
    { label: 'Settings', accelerator: 'Ctrl+,', click: () => shellRef.newTab('cloud://settings') },
    { type: 'separator' },
    { label: 'Zoom in', accelerator: 'Ctrl+=', click: () => tab?.setZoom(0.5) },
    { label: 'Zoom out', accelerator: 'Ctrl+-', click: () => tab?.setZoom(-0.5) },
    { label: 'Reset zoom', accelerator: 'Ctrl+0', click: () => tab?.setZoom(0) },
    { type: 'separator' },
    { label: 'Find in page', accelerator: 'Ctrl+F', click: () => shellRef.focusChrome('shell:open-find') },
    { label: 'Print…', enabled: Boolean(tab), click: () => tab?.webContents.print() },
    { type: 'separator' },
    {
      label: shellRef.store.get('theme') === 'night' ? 'Switch to day' : 'Switch to night',
      click: () => shellRef.setTheme(shellRef.store.get('theme') === 'night' ? 'day' : 'night')
    },
    { label: 'Developer tools', accelerator: 'Ctrl+Shift+I', click: () => tab?.webContents.toggleDevTools() }
  ]);

  menu.popup({ window: shellRef.window, x, y });
}

module.exports = { buildAppMenu, popupToolsMenu };
