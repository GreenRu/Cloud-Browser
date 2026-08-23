'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/**
 * The only surface the chrome UI has into the main process. Every channel is
 * listed explicitly - the renderer can never reach an arbitrary ipc channel.
 */
const listen = (channel) => (callback) => {
  const handler = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
};

contextBridge.exposeInMainWorld('cloud', {
  getState: () => ipcRenderer.invoke('shell:get-state'),

  tabs: {
    create: (url, opts) => ipcRenderer.send('tab:new', url, opts),
    close: (id) => ipcRenderer.send('tab:close', id),
    activate: (id) => ipcRenderer.send('tab:activate', id),
    move: (id, index) => ipcRenderer.send('tab:move', id, index),
    merge: (ids) => ipcRenderer.send('tab:merge', ids),
    setMuted: (id, muted) => ipcRenderer.send('tab:mute', id, muted)
  },

  nav: {
    go: (input) => ipcRenderer.send('nav:go', input),
    back: () => ipcRenderer.send('nav:back'),
    forward: () => ipcRenderer.send('nav:forward'),
    reload: (hard) => ipcRenderer.send('nav:reload', hard),
    stop: () => ipcRenderer.send('nav:stop'),
    home: () => ipcRenderer.send('nav:home')
  },

  view: {
    zoom: (delta) => ipcRenderer.send('view:zoom', delta),
    devtools: () => ipcRenderer.send('view:devtools'),
    setContentBounds: (rect, viewport) => ipcRenderer.send('view:content-bounds', rect, viewport),
    setSidebarWidth: (width) => ipcRenderer.send('view:sidebar-width', width),
    setTheme: (theme) => ipcRenderer.send('view:theme', theme)
  },

  preview: {
    resolve: (input) => ipcRenderer.invoke('preview:resolve', input),
    show: (input, rect, viewport) => ipcRenderer.send('preview:show', input, rect, viewport),
    hide: () => ipcRenderer.send('preview:hide')
  },

  find: {
    query: (text, opts) => ipcRenderer.send('find:query', text, opts),
    stop: () => ipcRenderer.send('find:stop')
  },

  bookmarks: {
    toggle: () => ipcRenderer.send('bookmark:toggle'),
    remove: (id) => ipcRenderer.send('bookmark:remove', id)
  },

  passwords: {
    resolve: (action) => ipcRenderer.send('passwords:resolve', action)
  },

  history: {
    list: (limit) => ipcRenderer.invoke('history:list', limit),
    clear: () => ipcRenderer.send('history:clear')
  },

  app: {
    openExternal: (url) => ipcRenderer.send('app:open-external', url),
    showItem: (path) => ipcRenderer.send('app:show-item', path),
    openMenu: (x, y) => ipcRenderer.send('app:open-menu', x, y)
  },

  on: {
    state: listen('shell:state'),
    findResult: listen('shell:find-result'),
    toast: listen('shell:toast'),
    focusOmnibox: listen('shell:focus-omnibox'),
    openFind: listen('shell:open-find'),
    savePassword: listen('shell:save-password'),
    previewTarget: listen('shell:preview-target'),
    previewExpanding: listen('shell:preview-expanding')
  }
});
