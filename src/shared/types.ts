/**
 * 共享类型定义
 * 对应 PLAN.md 的核心概念。主进程与渲染进程共用。
 */

/** 时间来源：按可信度从高到低排列 */
export enum DateSource {
  ExifDateTimeOriginal = 'exifDateTimeOriginal',
  ExifDateTimeDigitized = 'exifDateTimeDigitized',
  ExifDateTime = 'exifDateTime',
  XmpSidecar = 'xmpSidecar',
  Filename = 'filename',
  Birthtime = 'birthtime',
  Mtime = 'mtime',
  None = 'none'
}

/** 置信度等级（对应预览表颜色） */
export enum Confidence {
  High = 'high', // 绿 - EXIF 拍摄时间
  Medium = 'medium', // 黄 - 其他 EXIF / XMP / 文件名 / 创建时间
  Low = 'low', // 红 - 修改时间 / 无可用时间
  Conflict = 'conflict' // 紫 - 多来源日期矛盾
}

/** 排序策略（v1 实现 A + B） */
export enum SortStrategy {
  CaptureFirst = 'captureFirst', // A 拍摄优先（默认）
  SaveTimeFirst = 'saveTimeFirst' // B 保存时间优先
}

/** 输出模式：复制还是移动由用户所选模式决定，与路径无关 */
export enum OutputMode {
  InPlace = 'inPlace', // ① 原目录整理（移动，不复制）
  CopyToNew = 'copyToNew' // ② 指定路径新建文件夹（复制）
}

/** 命名形式 */
export enum NamingMode {
  FolderOnly = 'folderOnly', // 仅文件夹（默认，P0）
  FolderAndFile = 'folderAndFile' // 文件夹+文件重命名
}

/** 添加到文件夹：放入策略（用户可选项，取代自动判断） */
export enum AddPlacement {
  Flat = 'flat', // 直接放入目标文件夹，无视日期差异，不再建子文件夹
  ByDate = 'byDate' // 在目标文件夹内按图片日期继续新建子文件夹
}

/** 非图片元素处理策略 */
export enum NonImageStrategy {
  Skip = 'skip', // 跳过
  ToOtherFolder = 'toOtherFolder', // 按 mtime 归档到「其他文件/」
  ByExtension = 'byExtension' // 按扩展名归类
}

/** 单张图片的识别结果 */
export interface PhotoEntry {
  id: string
  sourcePath: string
  targetPath: string
  /** 识别出的日期 YYYY-MM-DD；无效/未识别为 0000-00-00 */
  date: string
  source: DateSource
  confidence: Confidence
  /** 是否为手工指定（单独添加功能里退出自动识别池的图片） */
  manual: boolean
  /** 预览勾选状态：高/中默认勾选，低/冲突默认不勾 */
  selected: boolean
  /** 缩略图 dataURL（可能为空，前端显示占位图标） */
  thumbnail?: string
  /** 时间戳描述，供预览表展示 */
  timeLabel?: string
  /** 关联文件（XMP sidecar / Live Photo .mov）的源路径，跟随主图一起归档 */
  companions?: string[]
  /** 目标文件夹是日期叶子文件夹时，其日期；与图片自身日期不符时前端标注提醒 */
  targetFolderDate?: string
  /** 图片自身日期与目标文件夹日期是否不符 */
  dateMismatch?: boolean
}

/** 归档任务配置 */
export interface OrganizeConfig {
  inputPaths: string[]
  outputMode: OutputMode
  outputDir?: string
  sortStrategy: SortStrategy
  namingMode: NamingMode
  nameTemplate?: string
  suffixWhitelist?: string[]
  recursive: boolean
  nonImageStrategy?: NonImageStrategy
  /** 目标目录已存在时的策略 */
  onTargetExists?: 'rename' | 'reject' | 'append'
  /** 添加到文件夹专用：直接放入 / 按图片日期新建子文件夹 */
  addPlacement?: AddPlacement
}

/** 扫描结果 */
export interface ScanResult {
  images: PhotoEntry[]
  nonImages: string[]
  /** 磁盘空间预检信息（模式②） */
  disk?: DiskSpace
}

/** 磁盘空间信息 */
export interface DiskSpace {
  /** 估算所需字节 */
  required: number
  /** 可用字节 */
  available: number
  /** 是否足够 */
  enough: boolean
}

/** 清单条目（用于撤销） */
export interface ManifestEntry {
  sourcePath: string
  targetPath: string
  mode: OutputMode
}

/** 清单（JSON 存于应用数据目录，不放进用户文件夹；支持跨重启撤销最近一次） */
export interface Manifest {
  version: number
  createdAt: string
  entries: ManifestEntry[]
  /** 本次创建的空目录（原地整理撤销时要删掉） */
  createdDirs?: string[]
}

/** 执行结果报告 */
export interface RunReport {
  succeeded: number
  failed: number
  skipped: number
  /** 异常图片：名称 + 完整路径，结束时弹窗列出 */
  errors: Array<{ name: string; path: string; reason: string }>
}

/** 进度回调数据 */
export interface ProgressInfo {
  done: number
  total: number
}

/** 主进程暴露给渲染进程的 API */
export interface ElectronAPI {
  selectDirectory: () => Promise<string | null>
  selectFiles: () => Promise<string[]>
  scan: (config: OrganizeConfig) => Promise<ScanResult>
  run: (entries: PhotoEntry[], config: OrganizeConfig) => Promise<RunReport>
  cancel: () => Promise<void>
  undo: () => Promise<boolean>
  showInExplorer: (path: string) => Promise<void>
  getThumbnail: (path: string) => Promise<string | null>
  readDirFormat: (dir: string) => Promise<Partial<OrganizeConfig> | null>
  /** 切换界面语言（同时影响主进程的对话框与错误文案） */
  setLanguage: (lang: 'zh-CN' | 'en') => Promise<void>
  onProgress: (callback: (info: ProgressInfo) => void) => void
}

declare global {
  interface Window {
    electronAPI: ElectronAPI
  }
}
