/**
 * 归档执行模块（对应 PLAN.md「输出模式 / 安全与撤销」）
 * 两种模式：①原地整理=移动不复制；②指定路径=复制。
 * 支持执行中取消并回滚本次变化。
 */
import { promises as fs } from 'fs'
import { basename, dirname, extname, join, resolve } from 'path'
import {
  OutputMode, NamingMode, NonImageStrategy, AddPlacement,
  type OrganizeConfig, type RunReport, type PhotoEntry, type ProgressInfo
} from '../shared/types'
import { writeManifest, type AppliedOp } from './manifest'

export interface RunHandle {
  cancel: () => Promise<void>
}

/** 目标目录已存在时：rename(加 _2) / reject(抛错) / append(沿用)。默认 rename */
export function resolveTargetConflict(targetPath: string, strategy: 'rename' | 'reject' | 'append' = 'rename'): string {
  return targetPath // 实际冲突处理在 ensureUniquePath 中按序号加后缀
}

/** 生成不覆盖已有文件的路径：name.ext -> name_1.ext -> name_2.ext */
async function ensureUniquePath(targetPath: string): Promise<string> {
  let candidate = targetPath
  let i = 0
  while (true) {
    try {
      await fs.access(candidate)
    } catch {
      return candidate // 不存在，可用
    }
    const ext = extname(targetPath)
    const base = targetPath.slice(0, targetPath.length - ext.length)
    candidate = `${base}_${++i}${ext}`
  }
}

/** 递归创建目录并记录新建的目录（供撤销删除） */
async function ensureDir(dir: string, created: Set<string>): Promise<void> {
  const abs = resolve(dir)
  if (created.has(abs)) return
  // 自顶向下收集需要创建的目录
  const missing: string[] = []
  let cur = abs
  while (true) {
    try {
      await fs.access(cur)
      break
    } catch {
      missing.push(cur)
      const parent = dirname(cur)
      if (parent === cur) break
      cur = parent
    }
  }
  for (const m of missing.reverse()) {
    await fs.mkdir(m).catch(() => { /* 并发已创建 */ })
    created.add(m)
  }
}

/** 应用模板生成文件名 */
function renderName(template: string, entry: PhotoEntry, originalName: string, seq: number): string {
  const ext = extname(originalName)
  const base = originalName.slice(0, originalName.length - ext.length)
  return template
    .replace(/\{YYYY-MM-DD\}/g, entry.date)
    .replace(/\{YYYYMMDD_HHMMSS\}/g, (entry.timeLabel || entry.date).replace(/[-: ]/g, ''))
    .replace(/\{序号\}/g, String(seq).padStart(4, '0'))
    .replace(/\{原文件名\}/g, base) + ext
}

/** 清理文件名中的非法字符，避免系统写入失败 */
function sanitize(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, '_').slice(0, 180)
}

/**
 * 执行归档。返回 handle 供 UI 调用 cancel。
 * 单文件异常即跳过，最后汇总到 report.errors。
 */
export async function runOrganize(
  entries: PhotoEntry[],
  config: OrganizeConfig,
  onProgress?: (info: ProgressInfo) => void,
  isCancelled?: () => boolean
): Promise<{ report: RunReport; handle: RunHandle }> {
  const report: RunReport = { succeeded: 0, failed: 0, skipped: 0, errors: [] }
  const selected = entries.filter((e) => e.selected)
  report.skipped = entries.length - selected.length

  let cancelled = false
  const handle: RunHandle = {
    cancel: async () => { cancelled = true }
  }

  const applied: AppliedOp[] = []
  const createdDirs = new Set<string>()
  const outputRoot = config.outputDir || ''
  const isInPlace = config.outputMode === OutputMode.InPlace

  let done = 0
  const total = selected.length

  for (const entry of selected) {
    if (cancelled || (isCancelled && isCancelled())) break

    try {
      // 目标目录：
      //   原地模式 = 源文件父目录；复制模式 = outputRoot
      //   放入方式 Flat（添加到文件夹时用户选了"直接放入"）= 不建日期子目录
      //   否则按图片日期建日期子目录（0000-00-00 也照常建）
      const dateFolder = entry.date
      const dirRoot = isInPlace ? dirname(entry.sourcePath) : outputRoot
      const flat = config.addPlacement === AddPlacement.Flat
      const targetDir = flat ? dirRoot : join(dirRoot, dateFolder)

      await ensureDir(targetDir, createdDirs)

      // 文件名
      let fileName = basename(entry.sourcePath)
      if (config.namingMode === NamingMode.FolderAndFile && config.nameTemplate) {
        fileName = renderName(config.nameTemplate, entry, fileName, report.succeeded + 1)
      }
      fileName = sanitize(fileName)

      let targetPath = await ensureUniquePath(join(targetDir, fileName))
      entry.targetPath = targetPath

      // 主文件：复制 or 移动
      if (isInPlace) {
        await fs.rename(entry.sourcePath, targetPath)
      } else {
        await fs.copyFile(entry.sourcePath, targetPath)
      }
      applied.push({ sourcePath: entry.sourcePath, targetPath, mode: config.outputMode })
      report.succeeded++

      // 关联文件跟随（XMP / Live Photo .mov）
      for (const comp of entry.companions || []) {
        try {
          const compTarget = await ensureUniquePath(join(targetDir, basename(comp)))
          if (isInPlace) await fs.rename(comp, compTarget)
          else await fs.copyFile(comp, compTarget)
          applied.push({ sourcePath: comp, targetPath: compTarget, mode: config.outputMode })
        } catch (e) {
          report.errors.push({
            name: basename(comp), path: comp,
            reason: e instanceof Error ? e.message : String(e)
          })
        }
      }
    } catch (e) {
      report.failed++
      report.errors.push({
        name: basename(entry.sourcePath),
        path: entry.sourcePath,
        reason: e instanceof Error ? e.message : String(e)
      })
    }

    done++
    onProgress?.({ done, total })
  }

  // 取消：回滚本次已产生的变化
  if (cancelled || (isCancelled && isCancelled())) {
    await rollback(applied, createdDirs)
    report.succeeded = 0
    report.failed = 0
    report.skipped = entries.length
    report.errors = [{ name: '—', path: '—', reason: '已取消，本次变化已回滚' }]
    return { report, handle }
  }

  // 写清单到应用数据目录（不放进用户文件夹），覆盖上一份，仅保留最近一次
  if (applied.length) {
    try {
      await writeManifest(applied, Array.from(createdDirs))
    } catch (e) {
      report.errors.push({
        name: 'manifest.json', path: '(应用数据目录)',
        reason: `清单写入失败，无法撤销：${e instanceof Error ? e.message : String(e)}`
      })
    }
  }

  return { report, handle }
}

/** 回滚已应用的操作 + 删除本次创建的空目录 */
export async function rollback(applied: AppliedOp[], createdDirs: Set<string>): Promise<void> {
  // 逆序处理
  for (const op of [...applied].reverse()) {
    try {
      if (op.mode === OutputMode.CopyToNew) {
        // 复制模式：删除复制出去的文件
        await fs.unlink(op.targetPath)
      } else {
        // 移动模式：移回原路径
        await fs.rename(op.targetPath, op.sourcePath)
      }
    } catch { /* 单个失败不影响其余回滚 */ }
  }
  // 删除本次创建的空目录（从深到浅）
  for (const dir of [...createdDirs].sort((a, b) => b.length - a.length)) {
    try {
      await fs.rmdir(dir) // 非空会抛错，忽略
    } catch { /* 忽略 */ }
  }
}

export { NonImageStrategy }
