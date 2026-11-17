import { contextBridge, ipcRenderer } from 'electron'
import type { BtvApi, TaskEvent } from '../shared/api-contract'

/**
 * 渲染层唯一可见的 API 面。所有通道必须在此白名单内显式暴露。
 */
const api: BtvApi = {
  app: {
    version: () => ipcRenderer.invoke('app:version')
  },
  config: {
    get: () => ipcRenderer.invoke('config:get'),
    set: (key, value) => ipcRenderer.invoke('config:set', key, value),
    masked: () => ipcRenderer.invoke('config:masked'),
    path: () => ipcRenderer.invoke('config:path'),
    openFile: () => ipcRenderer.invoke('config:openFile')
  },
  task: {
    submit: (params) => ipcRenderer.invoke('task:submit', params),
    list: () => ipcRenderer.invoke('task:list'),
    cancel: (taskId) => ipcRenderer.invoke('task:cancel', taskId),
    resume: (taskId) => ipcRenderer.invoke('task:resume', taskId),
    remove: (taskId) => ipcRenderer.invoke('task:remove', taskId),
    onEvent: (listener) => {
      const handler = (_event: unknown, payload: TaskEvent) => listener(payload)
      ipcRenderer.on('task:event', handler)
      return () => ipcRenderer.removeListener('task:event', handler)
    }
  },
  output: {
    open: (path) => ipcRenderer.invoke('output:open', path),
    readMarkdown: (path) => ipcRenderer.invoke('output:readMarkdown', path),
    listHistory: () => ipcRenderer.invoke('output:listHistory')
  }
}

contextBridge.exposeInMainWorld('btv', api)
