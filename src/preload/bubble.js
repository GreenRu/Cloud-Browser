'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/**
 * Bridge for the preview frame - the card drawn around the address bar's live
 * preview. It shows one line of text and forwards a press; nothing else is
 * exposed to it, and it never loads anything but its own page.
 */
contextBridge.exposeInMainWorld('cloudBubble', {
  onFrame: (callback) => {
    const handler = (_event, frame) => callback(frame);
    ipcRenderer.on('bubble:frame', handler);
    return () => ipcRenderer.removeListener('bubble:frame', handler);
  },
  activate: () => ipcRenderer.send('preview:activate')
});
