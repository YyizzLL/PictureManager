/**
 * 输入扫描模块（对应 PLAN.md「输入与格式支持 / 非图片元素处理」）
 * 扫描文件夹（可选递归）或多个文件，识别图片格式，分离非图片元素。
 * 关联文件（XMP 跟随 RAW、Live Photo 的 .mov 跟随 .heic）成组。
 */
import { promises as fs } from 'fs'
import { basename, extname, join } from 'path'

/** 支持的图片后缀（通用 / 手机 / RAW） */
export const IMAGE_EXTENSIONS = [
  // 通用
  'jpg', 'jpeg', 'png', 'gif', 'bmp', 'tif', 'tiff', 'webp', 'avif', 'jxl',
  // 手机 / 苹果
  'heic', 'heif',
  // RAW
  'cr2', 'cr3', 'nef', 'arw', 'dng', 'orf', 'raf', 'rw2', 'pef', 'srw', '3fr', 'iiq'
]

/** 明确排除的系统/隐藏文件 */
export const EXCLUDED_NAMES = new Set(['.ds_store', 'thumbs.db', 'desktop.ini'])

const IMAGE_EXT_SET = new Set(IMAGE_EXTENSIONS)

export interface ScanResult {
  images: string[]
  /** 非图片元素，交由 UI 弹窗提示（跳过 / 归档到其它文件夹 / 按扩展名归类） */
  nonImages: string[]
  /** 关联文件映射：主图 -> 需一起跟随的文件（XMP / Live Photo .mov） */
  companions: Map<string, string[]>
}

export function isImageFile(path: string): boolean {
  const ext = extname(path).slice(1).toLowerCase()
  return IMAGE_EXT_SET.has(ext)
}

function isExcluded(name: string): boolean {
  return EXCLUDED_NAMES.has(name.toLowerCase())
}

/** 递归收集目录下所有文件路径 */
async function walkDir(dir: string, recursive: boolean): Promise<string[]> {
  const out: string[] = []
  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    if (isExcluded(entry.name)) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (recursive) out.push(...(await walkDir(full, recursive)))
    } else if (entry.isFile()) {
      out.push(full)
    }
    // 符号链接：跳过（isSymbolicLink 不为 file/dir，天然跳过）
  }
  return out
}

/** 扫描输入路径，分离图片与非图片，并识别关联文件 */
export async function scanInputs(paths: string[], recursive: boolean): Promise<ScanResult> {
  const allFiles: string[] = []
  for (const p of paths) {
    let stat
    try {
      stat = await fs.stat(p)
    } catch {
      continue
    }
    if (stat.isDirectory()) {
      allFiles.push(...(await walkDir(p, recursive)))
    } else if (stat.isFile()) {
      allFiles.push(p)
    }
  }

  // 去重（按绝对路径）
  const unique = Array.from(new Set(allFiles))
  const images: string[] = []
  const nonImages: string[] = []
  for (const f of unique) {
    if (isImageFile(f)) images.push(f)
    else nonImages.push(f)
  }

  // 识别关联文件：对每个主图，找同目录同名的 .xmp / .mov
  const companions = new Map<string, string[]>()
  for (const img of images) {
    const ext = extname(img).toLowerCase()
    const base = img.slice(0, img.length - ext.length)
    const found: string[] = []
    // XMP sidecar：name.xmp 或 name.ext.xmp
    for (const cand of [`${base}.xmp`, `${img}.xmp`]) {
      try {
        await fs.access(cand)
        found.push(cand)
        break
      } catch { /* 不存在 */ }
    }
    // Live Photo：同名 .mov（仅 heic/heif 主图）
    if (['.heic', '.heif'].includes(ext)) {
      const mov = `${base}.mov`
      try {
        await fs.access(mov)
        found.push(mov)
      } catch { /* 不存在 */ }
    }
    if (found.length) companions.set(img, found)
  }

  // 从非图片列表里剔除已被识别为关联文件的项
  const companionSet = new Set<string>()
  for (const list of companions.values()) for (const c of list) companionSet.add(c.toLowerCase())
  const filteredNonImages = nonImages.filter((f) => !companionSet.has(f.toLowerCase()))

  return { images, nonImages: filteredNonImages, companions }
}

/** 读取目标文件夹的现有格式（用于「跟随现有格式」） */
export async function readDirFormat(dir: string): Promise<{ dateFolderStyle?: string; namingMode?: string } | null> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true })
    const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name)
    if (!dirs.length) return null
    const ymd = dirs.filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).length
    const ym = dirs.filter((d) => /^\d{4}-\d{2}$/.test(d)).length
    if (ymd === 0 && ym === 0) return null
    return { dateFolderStyle: ymd >= ym ? 'YYYY-MM-DD' : 'YYYY/MM' }
  } catch {
    return null
  }
}

/** 估算一批文件的总大小（字节） */
export async function estimateSize(files: string[]): Promise<number> {
  let total = 0
  for (const f of files) {
    try {
      const s = await fs.stat(f)
      total += s.size
    } catch { /* 忽略 */ }
  }
  return total
}
