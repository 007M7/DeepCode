const { contextBridge, ipcRenderer } = require('electron')

const api = {
  runtime: {
    start: () => ipcRenderer.invoke('runtime:start'),
    stop: () => ipcRenderer.invoke('runtime:stop'),
    restart: () => ipcRenderer.invoke('runtime:restart'),
    status: () => ipcRenderer.invoke('runtime:status'),
    onStatus: (callback) => {
      const listener = (_event, payload) => { callback(payload) }
      ipcRenderer.on('runtime:status-update', listener)
      return () => { ipcRenderer.removeListener('runtime:status-update', listener) }
    },
    onStderr: (callback) => {
      const listener = (_event, payload) => { callback(payload) }
      ipcRenderer.on('runtime:stderr', listener)
      return () => { ipcRenderer.removeListener('runtime:stderr', listener) }
    },
  },
  sessions: {
    list: () => ipcRenderer.invoke('sessions:list'),
    create: () => ipcRenderer.invoke('sessions:create'),
    load: (sessionId) => ipcRenderer.invoke('sessions:load', { sessionId }),
    prompt: (sessionId, text) => ipcRenderer.invoke('sessions:prompt', { sessionId, text }),
    cancel: (sessionId) => ipcRenderer.invoke('sessions:cancel', { sessionId }),
    reveal: (sessionId) => ipcRenderer.invoke('sessions:reveal', { sessionId }),
    onUpdate: (callback) => {
      const listener = (_event, payload) => { callback(payload) }
      ipcRenderer.on('sessions:update', listener)
      return () => { ipcRenderer.removeListener('sessions:update', listener) }
    },
  },
  trace: {
    read: (sessionId) => ipcRenderer.invoke('trace:read', { sessionId }),
  },
  feedback: {
    list: (sessionId, targetId) => ipcRenderer.invoke('feedback:list', { sessionId, targetId }),
    add: (entry) => ipcRenderer.invoke('feedback:add', entry),
  },
  dev: {
    status: () => ipcRenderer.invoke('dev:status'),
  },
}

contextBridge.exposeInMainWorld('dshDesktop', api)
