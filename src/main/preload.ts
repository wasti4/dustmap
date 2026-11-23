// Preload: exposes a small, typed API to the sandboxed renderer.
import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { EngineEvent, StorageApi } from '../shared/types';

const api: StorageApi = {
  startup: () => ipcRenderer.invoke('startup'),
  drives: (refresh) => ipcRenderer.invoke('drives', refresh),
  openDiskAccessSettings: () => ipcRenderer.invoke('openDiskAccessSettings'),
  relaunchElevated: (root) => ipcRenderer.invoke('relaunchElevated', root),
  chooseFolder: () => ipcRenderer.invoke('chooseFolder'),
  pathForFile: (file) => webUtils.getPathForFile(file),
  engine: (method, params) => ipcRenderer.invoke('engine', method, params),
  onEngineEvent: (cb) => {
    const handler = (_e: unknown, ev: EngineEvent) => cb(ev);
    ipcRenderer.on('engine:event', handler);
    return () => ipcRenderer.removeListener('engine:event', handler);
  },
  openPath: (p) => ipcRenderer.invoke('openPath', p),
  reveal: (p) => ipcRenderer.invoke('reveal', p),
  copyText: (t) => ipcRenderer.invoke('copyText', t),
  trash: (paths) => ipcRenderer.invoke('trash', paths),
  remove: (paths, mode) => ipcRenderer.invoke('remove', paths, mode),
  emptyRecycleBin: (root) => ipcRenderer.invoke('emptyRecycleBin', root),
  diskCleanup: (root) => ipcRenderer.invoke('diskCleanup', root),
  space: (root) => ipcRenderer.invoke('space', root),
  setChrome: (o) => ipcRenderer.invoke('setChrome', o),
};

contextBridge.exposeInMainWorld('storage', api);
