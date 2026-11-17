/**
 * 执行器回归测试：验证「放入方式」真的影响落盘目录
 *   1) addPlacement=flat  → 图片直接进目标文件夹，不建日期子目录
 *   2) addPlacement=byDate → 在目标文件夹里按日期建子目录
 *   3) 缺省（整理新照片）   → 仍按日期建子目录，行为不变
 *
 * 运行：npm run test:flat
 */
import { promises as fs } from 'fs'
import { join, basename } from 'path'
import { tmpdir } from 'os'
import { runOrganize } from '../src/main/organizer'
import {
  OutputMode, NamingMode, SortStrategy, AddPlacement, Confidence, DateSource,
  type PhotoEntry, type OrganizeConfig
} from '../src/shared/types'

let failed = 0
function check(name: string, ok: boolean, extra = ''): void {
  if (ok) console.log(`  PASS  ${name}`)
  else { failed++; console.log(`  FAIL  ${name}${extra ? '  ->  ' + extra : ''}`) }
}

function entry(sourcePath: string, date: string): PhotoEntry {
  return {
    id: `${sourcePath}#0`,
    sourcePath,
    targetPath: sourcePath,
    date,
    source: DateSource.Filename,
    confidence: Confidence.Medium,
    manual: false,
    selected: true
  }
}

function baseConfig(outputDir: string, addPlacement?: AddPlacement): OrganizeConfig {
  return {
    inputPaths: [],
    outputMode: OutputMode.CopyToNew,
    outputDir,
    sortStrategy: SortStrategy.CaptureFirst,
    namingMode: NamingMode.FolderOnly,
    recursive: true,
    addPlacement
  }
}

async function exists(p: string): Promise<boolean> {
  try { await fs.access(p); return true } catch { return false }
}

async function main(): Promise<void> {
  const root = join(tmpdir(), `pm-flat-test-${Date.now()}`)
  const srcDir = join(root, 'src')
  const flatTarget = join(root, '平铺目标')
  const byDateTarget = join(root, '按日期目标')
  const defaultTarget = join(root, '默认目标')
  for (const d of [srcDir, flatTarget, byDateTarget, defaultTarget]) await fs.mkdir(d, { recursive: true })

  const photos = [
    { name: 'IMG_20200301.jpg', date: '2020-03-01' },
    { name: 'IMG_20210715.jpg', date: '2021-07-15' }
  ]
  for (const p of photos) await fs.writeFile(join(srcDir, p.name), 'x')

  // ---- 1) flat ----
  console.log('\n[1] addPlacement = flat（直接放入，不建子目录）')
  {
    const entries = photos.map((p) => entry(join(srcDir, p.name), p.date))
    const { report } = await runOrganize(entries, baseConfig(flatTarget, AddPlacement.Flat))
    check('全部成功', report.succeeded === 2, JSON.stringify(report.errors))
    for (const p of photos) {
      check(`${p.name} 已在目标根目录`, await exists(join(flatTarget, p.name)))
      check(`${p.name} 未生成 ${p.date} 子目录`, !(await exists(join(flatTarget, p.date))))
    }
  }

  // ---- 2) byDate ----
  console.log('\n[2] addPlacement = byDate（按日期建子目录）')
  {
    const entries = photos.map((p) => entry(join(srcDir, p.name), p.date))
    const { report } = await runOrganize(entries, baseConfig(byDateTarget, AddPlacement.ByDate))
    check('全部成功', report.succeeded === 2, JSON.stringify(report.errors))
    for (const p of photos) {
      check(`${p.name} 在 ${p.date}/ 下`, await exists(join(byDateTarget, p.date, p.name)))
    }
  }

  // ---- 3) 缺省（整理新照片流程不传 addPlacement）----
  console.log('\n[3] addPlacement 缺省（整理新照片，行为不变）')
  {
    const entries = photos.map((p) => entry(join(srcDir, p.name), p.date))
    const { report } = await runOrganize(entries, baseConfig(defaultTarget))
    check('全部成功', report.succeeded === 2, JSON.stringify(report.errors))
    for (const p of photos) {
      check(`${p.name} 在 ${p.date}/ 下`, await exists(join(defaultTarget, p.date, p.name)))
    }
  }

  // ---- 4) 返回值里的 targetPath 与实际落盘一致 ----
  console.log('\n[4] 执行后 entry.targetPath 与实际路径一致')
  {
    const flat2 = join(root, '平铺目标2')
    await fs.mkdir(flat2, { recursive: true })
    const entries = [entry(join(srcDir, photos[0].name), photos[0].date)]
    await runOrganize(entries, baseConfig(flat2, AddPlacement.Flat))
    check('targetPath 不含日期目录', !entries[0].targetPath.includes(photos[0].date), entries[0].targetPath)
    check('targetPath 指向真实文件', await exists(entries[0].targetPath), entries[0].targetPath)
  }

  await fs.rm(root, { recursive: true, force: true })
  console.log(failed ? `\n=== 失败 ${failed} 项 ===` : '\n=== 全部通过 ===')
  process.exit(failed ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
