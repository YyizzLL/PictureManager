/**
 * 日期识别模块（对应 PLAN.md「时间戳识别」）
 * 按 7 类时间来源的可信度降级读取，标记置信度与冲突。
 * 统一按本地墙上时间解释，不转 UTC。
 */
import { promises as fs } from 'fs'
import { basename, extname } from 'path'
import { exiftool } from 'exiftool-vendored'
import { DateSource, Confidence, SortStrategy } from '../shared/types'

/** 冲突阈值：两个来源日期相差 > 1 天即标记冲突 */
export const CONFLICT_THRESHOLD_DAYS = 1

/** 无效/未识别日期统一值 */
export const INVALID_DATE = '0000-00-00'

export interface DetectedDate {
  date: string
  source: DateSource
  confidence: Confidence
  conflict: boolean
  /** 日期时间完整串（供展示） */
  timeLabel?: string
}

interface Candidate {
  date: string // YYYY-MM-DD
  timeLabel?: string
  source: DateSource
  confidence: Confidence
  /** 用于冲突比对的毫秒时间戳（本地墙上时间解释） */
  ms: number
  /** 是否参与冲突比对：仅高/中可信来源（EXIF/XMP/文件名）参与，
   *  文件系统时间(birthtime/mtime)只是兜底，不作为冲突依据，否则截图/下载图会全部误报冲突 */
  conflictEligible: boolean
}

function pad(n: number): string { return String(n).padStart(2, '0') }

/** 把 Date 按本地墙上时间格式化为 YYYY-MM-DD 和完整串 */
function formatLocal(d: Date): { date: string; timeLabel: string; ms: number } {
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  const timeLabel = `${date} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  return { date, timeLabel, ms: d.getTime() }
}

/** 从 "2023:01:02 03:04:05" / "2023:01:02 03:04:05+08:00" 解析为本地时间 Date */
function parseExifDate(raw: unknown): Date | null {
  if (raw == null) return null
  let s = ''
  if (raw instanceof Date) return raw
  if (typeof raw === 'object') {
    const o = raw as Record<string, unknown>
    // exiftool-vendored 的 ExifDateTime：year/month/day/hour/minute/second
    const y = Number(o.year), mo = Number(o.month), d = Number(o.day)
    if (y && mo && d) return new Date(y, mo - 1, d, Number(o.hour) || 0, Number(o.minute) || 0, Number(o.second) || 0)
    return null
  }
  if (typeof raw !== 'string') return null
  s = String(raw)
  // 去掉时区偏移，按墙上时间解释
  s = s.replace(/[+-]\d{2}:?\d{2}$/, '').trim()
  const m = s.match(/^(\d{4})[:\-/](\d{1,2})[:\-/](\d{1,2})(?:[ T](\d{1,2}):(\d{1,2}):(\d{1,2}))?/)
  if (!m) return null
  return new Date(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0))
}

/** 判断日期字符串是否合法 */
export function isValidDate(date: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false
  if (date === INVALID_DATE) return false
  const [y, m, d] = date.split('-').map(Number)
  if (y < 1900 || m < 1 || m > 12 || d < 1 || d > 31) return false
  const dt = new Date(y, m - 1, d)
  if (dt.getFullYear() !== y || dt.getMonth() !== m - 1 || dt.getDate() !== d) return false
  // 明显未来日期（超过今天 1 天）视为无效
  const now = new Date()
  now.setDate(now.getDate() + 1)
  if (dt.getTime() > now.getTime()) return false
  return true
}

/** 文件名日期正则白名单 */
const FILENAME_PATTERNS: Array<{ re: RegExp; kind: 'ymd' | 'ms' | 'sec' }> = [
  { re: /(\d{4})[-_.](\d{2})[-_.](\d{2})/, kind: 'ymd' }, // 2023-01-02 / 2023_01_02
  { re: /(\d{4})(\d{2})(\d{2})/, kind: 'ymd' }, // IMG_20230102_123456 / PXL_20230102
  { re: /mmexport(\d{13})/, kind: 'ms' }, // 微信 mmexport<毫秒>
  { re: /wx_camera_(\d{10})/, kind: 'sec' }, // 微信 wx_camera_<秒>
  { re: /IMG[-_](\d{4})(\d{2})(\d{2})/, kind: 'ymd' } // WhatsApp IMG-20230102-WA0000
]

/** 从文件名提取日期 */
function dateFromFilename(name: string): Date | null {
  for (const { re, kind } of FILENAME_PATTERNS) {
    const m = name.match(re)
    if (!m) continue
    if (kind === 'ymd') {
      const y = +m[1], mo = +m[2], d = +m[3]
      if (y >= 1900 && mo >= 1 && mo <= 12 && d >= 1 && d <= 31) return new Date(y, mo - 1, d)
    } else if (kind === 'ms') {
      const ts = +m[1]
      if (!Number.isNaN(ts)) return new Date(ts)
    } else if (kind === 'sec') {
      const ts = +m[1]
      if (!Number.isNaN(ts)) return new Date(ts * 1000)
    }
  }
  return null
}

/** 收集所有候选日期 */
async function collectCandidates(filePath: string): Promise<Candidate[]> {
  const candidates: Candidate[] = []
  const name = basename(filePath)

  // 1-3. EXIF 三字段（带 3s 超时：Electron 里 exiftool 子进程异常时不能卡死整个预览）
  try {
    const tags = await Promise.race([
      exiftool.read(filePath),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('EXIF 读取超时')), 3000))
    ])
    const fields: Array<[DateSource, Confidence, unknown]> = [
      [DateSource.ExifDateTimeOriginal, Confidence.High, tags.DateTimeOriginal],
      [DateSource.ExifDateTimeDigitized, Confidence.Medium, tags.DateTimeDigitized],
      [DateSource.ExifDateTime, Confidence.Medium, (tags as Record<string, unknown>).DateTime]
    ]
    for (const [source, confidence, raw] of fields) {
      const d = parseExifDate(raw)
      if (d) candidates.push({ ...formatLocal(d), source, confidence, conflictEligible: true })
    }
  } catch { /* 非图片、读取失败或超时，继续降级到文件名/文件时间 */ }

  // 4. XMP sidecar（同名 .xmp）
  try {
    const ext = extname(filePath)
    const base = filePath.slice(0, filePath.length - ext.length)
    const xmpPath = `${base}.xmp`
    let xmp = ''
    try { xmp = await fs.readFile(xmpPath, 'utf-8') } catch { /* 无 sidecar */ }
    if (xmp) {
      const m = xmp.match(/(?:photoshop:DateCreated|xmp:CreateDate|dc:date)[=>\s"']+(\d{4})[-:](\d{2})[-:](\d{2})/i)
      if (m) {
        const d = new Date(+m[1], +m[2] - 1, +m[3])
        candidates.push({ ...formatLocal(d), source: DateSource.XmpSidecar, confidence: Confidence.Medium, conflictEligible: true })
      }
    }
  } catch { /* 忽略 */ }

  // 5. 文件名日期（白名单模式才算中置信度）
  const fnDate = dateFromFilename(name)
  if (fnDate) candidates.push({ ...formatLocal(fnDate), source: DateSource.Filename, confidence: Confidence.Medium, conflictEligible: true })

  // 6-7. 文件系统时间
  try {
    const stat = await fs.stat(filePath)
    candidates.push({ ...formatLocal(new Date(stat.birthtime)), source: DateSource.Birthtime, confidence: Confidence.Medium, conflictEligible: false })
    candidates.push({ ...formatLocal(new Date(stat.mtime)), source: DateSource.Mtime, confidence: Confidence.Low, conflictEligible: false })
  } catch { /* 忽略 */ }

  return candidates
}

/** 把候选按优先级排序（可信度：来源顺序 + 置信度） */
function sourceRank(source: DateSource): number {
  const order = [
    DateSource.ExifDateTimeOriginal, DateSource.ExifDateTimeDigitized, DateSource.ExifDateTime,
    DateSource.XmpSidecar, DateSource.Filename, DateSource.Birthtime, DateSource.Mtime, DateSource.None
  ]
  const i = order.indexOf(source)
  return i === -1 ? 99 : i
}

/**
 * 从文件识别日期。
 * strategy=A 拍摄优先：取最高优先级的候选；
 * strategy=B 保存时间优先：只看 birthtime/mtime；
 * 两来源相差 > 1 天 → 冲突，默认不勾选，交用户决定。
 */
export async function detectDate(filePath: string, strategy: SortStrategy = SortStrategy.CaptureFirst): Promise<DetectedDate> {
  let candidates = await collectCandidates(filePath)

  if (strategy === SortStrategy.SaveTimeFirst) {
    candidates = candidates.filter((c) => c.source === DateSource.Birthtime || c.source === DateSource.Mtime)
    // 保存时间优先：birthtime 优先于 mtime
    candidates.sort((a, b) => sourceRank(a.source) - sourceRank(b.source))
  } else {
    candidates.sort((a, b) => sourceRank(a.source) - sourceRank(b.source))
  }

  if (!candidates.length) {
    return { date: INVALID_DATE, source: DateSource.None, confidence: Confidence.Low, conflict: false }
  }

  const best = candidates[0]

  // 冲突检测：只在参与比对的高/中可信来源之间比较（EXIF/XMP/文件名）。
  // 文件系统时间(birthtime/mtime)不作为冲突依据——它们与拍摄日期本就不同。
  let conflict = false
  if (strategy === SortStrategy.CaptureFirst) {
    const eligible = candidates.filter((c) => c.conflictEligible)
    if (eligible.length >= 2) {
      const top = eligible[0]
      for (let i = 1; i < eligible.length; i++) {
        if (Math.abs(top.ms - eligible[i].ms) > CONFLICT_THRESHOLD_DAYS * 24 * 60 * 60 * 1000) {
          conflict = true
          break
        }
      }
    }
  }

  const date = isValidDate(best.date) ? best.date : INVALID_DATE
  return {
    date,
    source: best.source,
    confidence: conflict ? Confidence.Conflict : best.confidence,
    conflict,
    timeLabel: best.timeLabel
  }
}

/** 关闭 exiftool 子进程（应用退出时调用） */
export async function closeExiftool(): Promise<void> {
  try { await exiftool.end() } catch { /* 忽略 */ }
}
