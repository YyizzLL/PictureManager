/** 预加载脚本：安全地向渲染进程暴露受控 API */
import { contextBridge, ipcRenderer } from 'electron'
import type { ElectronAPI, ProgressInfo } from '../shared/types'

const api: ElectronAPI = {
  selectDirectory: () => ipcRenderer.invoke('selectDirectory'),
  selectFiles: () => ipcRenderer.invoke('selectFiles'),
  scan: (config) => ipcRenderer.invoke('scan', config),
  run: (entries, config) => ipcRenderer.invoke('run', entries, config),
  cancel: () => ipcRenderer.invoke('cancel'),
  undo: () => ipcRenderer.invoke('undo'),
  showInExplorer: (path) => ipcRenderer.invoke('showInExplorer', path),
  getThumbnail: (path) => ipcRenderer.invoke('getThumbnail', path),
  readDirFormat: (dir) => ipcRenderer.invoke('readDirFormat', dir),
  setLanguage: (lang) => ipcRenderer.invoke('setLanguage', lang),
  onProgress: (callback: (info: ProgressInfo) => void) => {
    ipcRenderer.on('progress', (_event, info: ProgressInfo) => callback(info))
  }
}

contextBridge.exposeInMainWorld('electronAPI', api)
