import { app, BrowserWindow, ipcMain, shell } from 'electron'
import { join } from 'node:path'
import { bootstrap } from './services'

let services: ReturnType<typeof bootstrap> | null = null

function currentWindow(): BrowserWindow | null {
  return BrowserWindow.getAllWindows().find((w) => !w.isDestroyed()) ?? null
}

function createWindow(): void {
  const window = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 960,
    minHeight: 640,
    show: false,
    autoHideMenuBar: true,
    title: 'btv-summary',
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  window.once('ready-to-show', () => window.show())
  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    void window.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

ipcMain.handle('app:version', () => app.getVersion())

app.whenReady().then(() => {
  // 服务与 IPC 通道只在应用生命周期内注册一次；重复注册会抛出
  // "Attempted to register a second handler"
  services = bootstrap(currentWindow)
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  services?.shutdown()
})
