'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/**
 * Bridge for the cloud menu.
 *
 * The menu is a view of its own because the chrome sits *under* the page: a
 * menu drawn there is clipped the moment it reaches past the sidebar. It is
 * handed a list of items and hands back the name of whichever was chosen.
 * Nothing else is exposed to it.
 */
contextBridge.exposeInMainWorld('cloudMenu', {
  onMenu: (callback) => {
    const handler = (_event, menu) => callback(menu);
    ipcRenderer.on('menu:show', handler);
    return () => ipcRenderer.removeListener('menu:show', handler);
  },
  /** How big the card turned out, and where in the view it sits. */
  measured: (size) => ipcRenderer.send('menu:size', size),
  run: (action) => ipcRenderer.send('menu:run', action),
  close: () => ipcRenderer.send('menu:close')
});
