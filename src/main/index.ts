/**
 * Electron 主进程入口
 * 创建窗口、注册 IPC handler。业务逻辑委托给 scanner / dateExtractor / organizer / manifest。
 */
import { app, BrowserWindow, ipcMain, dialog, shell, nativeImage } from 'electron'
import { join, basename, dirname, extname } from 'path'
import { promises as fs } from 'fs'
import {
  OutputMode, NamingMode, Confidence, SortStrategy, AddPlacement,
  type OrganizeConfig, type PhotoEntry, type RunReport, type ScanResult, type ProgressInfo
} from '../shared/types'
import { t, type Lang } from '../shared/i18n'

const isDev = process.env['NODE_ENV'] === 'development' || !!process.env['ELECTRON_RENDERER_URL']
/** 当前界面语言，由渲染进程通过 setLanguage 同步 */
let lang: Lang = 'zh-CN'

import { scanInputs, readDirFormat, estimateSize } from './scanner'
import { detectDate, closeExiftool, INVALID_DATE } from './dateExtractor'
import { runOrganize } from './organizer'
import { undo } from './manifest'

let mainWindow: BrowserWindow | null = null
/** 当前运行是否被取消 */
let cancelRequested = false
/** 当前运行的 handle */
let currentHandle: { cancel: () => Promise<void> } | null = null

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 760,
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow?.show())
  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (isDev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

/** 生成缩略图 dataURL（失败返回 null，前端显示占位图标） */
async function makeThumbnail(path: string): Promise<string | null> {
  try {
    const img = nativeImage.createFromPath(path)
    if (img.isEmpty()) return null
    return img.resize({ width: 64, height: 64, quality: 'good' }).toDataURL()
  } catch {
    return null
  }
}

/** 计算目标输出根：模式②且有 outputDir 用它；否则默认输入旁 */
function resolveOutputRoot(config: OrganizeConfig): string {
  if (config.outputDir) return config.outputDir
  return '' // 由 UI 保证传入；兜底空串
}

/** 读磁盘可用空间 */
async function diskAvailable(dir: string): Promise<number> {
  try {
    const s = await fs.statfs(dir)
    return Number(s.bavail) * Number(s.bsize)
  } catch {
    return Number.MAX_SAFE_INTEGER // 无法检测则视为充足
  }
}

app.whenReady().then(() => {
  app.setAppUserModelId('com.yyizzll.picturemanager')

  // ---- 选择路径 ----
  ipcMain.handle('selectDirectory', async () => {
    const r = await dialog.showOpenDialog({ properties: ['openDirectory'] })
    return r.canceled ? null : r.filePaths[0]
  })

  ipcMain.handle('selectFiles', async () => {
    const r = await dialog.showOpenDialog({
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: t(lang, 'filterImages'), extensions: ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'tif', 'tiff', 'webp', 'avif', 'jxl', 'heic', 'heif', 'cr2', 'cr3', 'nef', 'arw', 'dng', 'orf', 'raf', 'rw2', 'pef', 'srw', '3fr', 'iiq'] }]
    })
    return r.canceled ? [] : r.filePaths
  })

  // ---- 扫描 + 日期识别，组装预览表 ----
  ipcMain.handle('scan', async (_e, config: OrganizeConfig): Promise<ScanResult> => {
    try {
    const scan = await scanInputs(config.inputPaths, config.recursive)
    const outputRoot = resolveOutputRoot(config)
    const entries: PhotoEntry[] = []

    // 添加到文件夹：由用户选择的放入策略决定
    // Flat=直接放入目标文件夹（无视日期）；ByDate=在目标文件夹内按图片日期建子文件夹
    const targetName = outputRoot ? basename(outputRoot) : ''
    const placement = config.addPlacement || AddPlacement.ByDate

    for (const img of scan.images) {
      const detected = await detectDate(img, config.sortStrategy)
      const selected = detected.confidence === Confidence.High || detected.confidence === Confidence.Medium
      const dateFolder = detected.date || INVALID_DATE
      let targetDir: string
      if (placement === AddPlacement.Flat) {
        targetDir = outputRoot // 直接放入目标文件夹，不建子目录
      } else if (config.outputMode === OutputMode.InPlace) {
        targetDir = join(dirname(img), dateFolder)
      } else {
        targetDir = join(outputRoot, dateFolder)
      }
      // 日期不符标注：目标文件夹是日期名、且图片日期与之不同（仅 Flat 时有意义）
      const isDateLeaf = /^\d{4}-\d{2}-\d{2}$/.test(targetName)
      const dateMismatch = placement === AddPlacement.Flat && isDateLeaf && detected.date !== targetName
      let fileName = basename(img)
      if (config.namingMode === NamingMode.FolderAndFile && config.nameTemplate) {
        fileName = config.nameTemplate
          .replace(/\{YYYY-MM-DD\}/g, detected.date)
          .replace(/\{YYYYMMDD_HHMMSS\}/g, (detected.timeLabel || detected.date).replace(/[-: ]/g, ''))
          .replace(/\{原文件名\}/g, basename(img, extname(img)))
          .replace(/\{序号\}/g, String(entries.length + 1).padStart(4, '0')) + extname(img)
      }
      entries.push({
        id: `${img}#${entries.length}`,
        sourcePath: img,
        targetPath: join(targetDir, fileName),
        date: detected.date,
        source: detected.source,
        confidence: detected.confidence,
        manual: false,
        selected,
        companions: scan.companions.get(img) || [],
        timeLabel: detected.timeLabel,
        targetFolderDate: placement === AddPlacement.Flat && isDateLeaf ? targetName : undefined,
        dateMismatch
      })
    }

    // 缩略图（缩略图生成较重，只给前 200 张生成，其余前端按需请求）
    for (let i = 0; i < Math.min(entries.length, 200); i++) {
      entries[i].thumbnail = (await makeThumbnail(entries[i].sourcePath)) || undefined
    }

    // 磁盘空间预检（仅模式②）
    let disk: ScanResult['disk']
    if (config.outputMode === OutputMode.CopyToNew && outputRoot) {
      const required = await estimateSize(scan.images)
      const available = await diskAvailable(outputRoot)
      disk = { required, available, enough: available >= required }
    }

    return { images: entries, nonImages: scan.nonImages, disk }
    } catch (err) {
      throw new Error(t(lang, 'scanFailed', { msg: err instanceof Error ? err.message : String(err) }))
    }
  })

  // ---- 按需取缩略图（预览表滚动到时前端请求） ----
  ipcMain.handle('getThumbnail', async (_e, path: string) => makeThumbnail(path))

  // ---- 读取目标文件夹现有格式 ----
  ipcMain.handle('readDirFormat', async (_e, dir: string) => {
    const fmt = await readDirFormat(dir)
    if (!fmt) return null
    return fmt.dateFolderStyle === 'YYYY/MM'
      ? { namingMode: NamingMode.FolderOnly, outputMode: OutputMode.CopyToNew }
      : { namingMode: NamingMode.FolderOnly, outputMode: OutputMode.CopyToNew }
  })

  // ---- 执行归档 ----
  ipcMain.handle('run', async (_e, entries: PhotoEntry[], config: OrganizeConfig): Promise<RunReport> => {
    cancelRequested = false
    const onProgress = (info: ProgressInfo) => {
      mainWindow?.webContents.send('progress', info)
    }
    const { report, handle } = await runOrganize(entries, config, onProgress, () => cancelRequested, lang)
    currentHandle = handle
    return report
  })

  // ---- 取消 ----
  ipcMain.handle('cancel', async () => {
    cancelRequested = true
    if (currentHandle) await currentHandle.cancel()
  })

  // ---- 撤销 ----
  ipcMain.handle('undo', async () => undo())

  // ---- 在资源管理器中显示 ----
  ipcMain.handle('showInExplorer', async (_e, path: string) => shell.showItemInFolder(path))

  // ---- 语言切换（渲染层切换后同步，影响原生对话框与错误文案）----
  ipcMain.handle('setLanguage', async (_e, next: Lang) => {
    lang = next === 'en' ? 'en' : 'zh-CN'
  })

  createWindow()
})

app.on('window-all-closed', () => {
  closeExiftool()
  if (process.platform !== 'darwin') app.quit()
})
