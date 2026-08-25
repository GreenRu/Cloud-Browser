'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/**
 * Bridge for the flights panel.
 *
 * The panel is a view of its own because it hangs down from a button in the
 * sidebar, straight into the page, and the chrome cannot draw there. It is
 * handed the whole state whenever anything moves, and hands back the name of a
 * flight and what to do to it - never a path, never a download.
 */
contextBridge.exposeInMainWorld('flightsPanel', {
  /** Opened. Carries the theme, since a view has no stylesheet of the chrome's. */
  onShow: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('flights:show', handler);
    return () => ipcRenderer.removeListener('flights:show', handler);
  },
  onState: (callback) => {
    const handler = (_event, state) => callback(state);
    ipcRenderer.on('flights:state', handler);
    return () => ipcRenderer.removeListener('flights:state', handler);
  },
  list: () => ipcRenderer.invoke('flights:list'),
  act: (action, id) => ipcRenderer.invoke('flights:act', action, id),
  /** How big the panel turned out, and where in the view it sits. */
  measured: (size) => ipcRenderer.send('flights:panel-size', size),
  close: () => ipcRenderer.send('flights:panel-close'),
  openPage: () => ipcRenderer.send('tab:new', 'stratus://flights')
});
