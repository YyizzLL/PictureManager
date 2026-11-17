/**
 * 清单与撤销模块
 * 清单 JSON 存于应用数据目录（%APPDATA%/PictureManager/ 等），**不放进用户的输出文件夹**，
 * 保持用户目录干净。支持跨重启撤销最近一次操作（每次覆盖同一份）。
 * 撤销前校验文件未被改动；移回时同样不覆盖。
 */
import { promises as fs } from 'fs'
import { join } from 'path'
import { app } from 'electron'
import { createHash } from 'crypto'
import { OutputMode, type Manifest } from '../shared/types'

const MANIFEST_FILENAME = 'manifest.json'

/** 清单固定存放目录：应用数据目录（用户不可见，不污染输出文件夹） */
function manifestDir(): string {
  return app.getPath('userData')
}

/** AppliedOp 与 ManifestEntry 结构一致，额外可选哈希 */
export interface AppliedOp {
  sourcePath: string
  targetPath: string
  mode: OutputMode
  /** 复制时记录目标文件哈希，撤销前校验未被改动 */
  targetHash?: string
}

interface StoredManifest {
  version: number
  createdAt: string
  entries: AppliedOp[]
  createdDirs: string[]
}

/** 计算文件 SHA256 */
async function hashFile(path: string): Promise<string | null> {
  try {
    const buf = await fs.readFile(path)
    return createHash('sha256').update(buf).digest('hex')
  } catch {
    return null
  }
}

/** 写入清单到应用数据目录（覆盖上一份，天然只保留最近一次） */
export async function writeManifest(entries: AppliedOp[], createdDirs: string[] = []): Promise<void> {
  const stored: AppliedOp[] = []
  for (const e of entries) {
    const hash = e.mode === OutputMode.CopyToNew ? await hashFile(e.targetPath) : undefined
    stored.push({ ...e, targetHash: hash ?? undefined })
  }
  const manifest: StoredManifest = {
    version: 1,
    createdAt: new Date().toISOString(),
    entries: stored,
    createdDirs
  }
  await fs.mkdir(manifestDir(), { recursive: true })
  await fs.writeFile(join(manifestDir(), MANIFEST_FILENAME), JSON.stringify(manifest, null, 2), 'utf-8')
}

/** 读取最近一次清单 */
export async function readManifest(): Promise<Manifest | null> {
  try {
    const raw = await fs.readFile(join(manifestDir(), MANIFEST_FILENAME), 'utf-8')
    const parsed = JSON.parse(raw) as StoredManifest
    return {
      version: parsed.version,
      createdAt: parsed.createdAt,
      entries: parsed.entries.map((e) => ({
        sourcePath: e.sourcePath, targetPath: e.targetPath, mode: e.mode
      })),
      createdDirs: parsed.createdDirs
    }
  } catch {
    return null
  }
}

/** 读取带哈希的原始清单（内部用） */
async function readStoredManifest(): Promise<StoredManifest | null> {
  try {
    const raw = await fs.readFile(join(manifestDir(), MANIFEST_FILENAME), 'utf-8')
    return JSON.parse(raw) as StoredManifest
  } catch {
    return null
  }
}

/**
 * 撤销最近一次操作。
 * 模式②(复制)：删除本次复制出去的文件（先校验哈希未被改动）；
 * 模式①(移动)：移回原路径（不覆盖）+ 删除本次创建的日期子文件夹。
 */
export async function undo(): Promise<boolean> {
  const manifest = await readStoredManifest()
  if (!manifest || !manifest.entries.length) return false

  let allOk = true

  for (const op of [...manifest.entries].reverse()) {
    try {
      if (op.mode === OutputMode.CopyToNew) {
        const currentHash = await hashFile(op.targetPath)
        if (op.targetHash && currentHash !== op.targetHash) {
          allOk = false // 文件被改过，跳过不删，避免误删用户改动
          continue
        }
        await fs.unlink(op.targetPath)
      } else {
        try {
          await fs.access(op.sourcePath)
          allOk = false // 原路径被占用，跳过
          continue
        } catch { /* 可用 */ }
        await fs.rename(op.targetPath, op.sourcePath)
      }
    } catch {
      allOk = false
    }
  }

  // 删除本次创建的空目录（从深到浅）
  for (const dir of [...(manifest.createdDirs || [])].sort((a, b) => b.length - a.length)) {
    try {
      await fs.rmdir(dir)
    } catch { /* 非空或有内容，忽略 */ }
  }

  // 删除清单本身（已撤销，避免重复撤销）
  try {
    await fs.unlink(join(manifestDir(), MANIFEST_FILENAME))
  } catch { /* 忽略 */ }

  return allOk
}

export { MANIFEST_FILENAME }
