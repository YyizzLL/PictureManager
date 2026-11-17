/**
 * 主窗口 UI（P0）
 * 两个并列入口：整理新照片 / 添加到文件夹；关于卡片；结果报告与撤销。
 */
import { useCallback, useEffect, useState, type Dispatch, type SetStateAction } from 'react'
import {
  OutputMode, NamingMode, SortStrategy, NonImageStrategy, Confidence, DateSource, AddPlacement,
  type PhotoEntry, type OrganizeConfig, type ScanResult, type RunReport,
  type ProgressInfo
} from '../../shared/types'

type Tab = 'organize' | 'append'

const confidenceLabel: Record<string, string> = {
  [Confidence.High]: '高·拍摄时间',
  [Confidence.Medium]: '中·其他来源',
  [Confidence.Low]: '低·修改时间',
  [Confidence.Conflict]: '冲突'
}
const sourceLabel: Record<string, string> = {
  [DateSource.ExifDateTimeOriginal]: 'EXIF拍摄',
  [DateSource.ExifDateTimeDigitized]: 'EXIF数字化',
  [DateSource.ExifDateTime]: 'EXIF时间',
  [DateSource.XmpSidecar]: 'XMP',
  [DateSource.Filename]: '文件名',
  [DateSource.Birthtime]: '创建时间',
  [DateSource.Mtime]: '修改时间',
  [DateSource.None]: '无'
}

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
}

function basename(path: string): string {
  return path.split(/[\\/]/).pop() || path
}

function dirnameStr(path: string): string {
  const i = Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/'))
  return i >= 0 ? path.slice(0, i) : ''
}

/** 常见图片/关联文件扩展名，用于在「已选来源」里区分文件与文件夹 */
const FILE_EXT_RE = /\.(jpe?g|jfif|png|gif|bmp|webp|tiff?|avif|heic|heif|mov|mp4|xmp|dng|cr2|cr3|nef|arw|raf|orf|rw2|pef|srw|raw|x3f|3fr|rwl)$/i

function isFilePath(path: string): boolean {
  return FILE_EXT_RE.test(path)
}

/** 路径归一化，用于判重（忽略大小写与尾部分隔符差异） */
function normalizePath(path: string): string {
  return path.replace(/[\\/]+$/, '').replace(/\//g, '\\').toLowerCase()
}

/** 合并新选择，跳过已存在的路径（同一路径重复选入会导致重复扫描） */
function mergePaths(existing: string[], add: string[]): string[] {
  const seen = new Set(existing.map(normalizePath))
  const next = [...existing]
  for (const p of add) {
    const key = normalizePath(p)
    if (!seen.has(key)) {
      seen.add(key)
      next.push(p)
    }
  }
  return next
}

/**
 * 已选来源查看弹窗：列出已选的图片/文件夹，可逐个移除、继续添加、一键清空。
 * 两个面板共用，保证交互一致。
 */
function SelectedInputs({ paths, onChange, onClose, onAddFiles, onAddFolder }: {
  paths: string[]
  onChange: (next: string[]) => void
  onClose: () => void
  onAddFiles: () => void
  onAddFolder: () => void
}) {
  const fileCount = paths.filter(isFilePath).length
  const dirCount = paths.length - fileCount
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="card inputs-card" onClick={(e) => e.stopPropagation()}>
        <h2>已选来源（{paths.length}）</h2>
        <p className="hint">
          共 {paths.length} 项：图片文件 {fileCount} 个、文件夹 {dirCount} 个。可在此继续添加或逐个移除，重复路径不会重复加入。
        </p>

        {paths.length === 0
          ? <p className="hint empty-tip">还没有选择任何图片或文件夹，点下方按钮添加。</p>
          : (
            <div className="inputs-list">
              {paths.map((p, i) => (
                <div className="inputs-item" key={`${p}#${i}`}>
                  <span className={`kind ${isFilePath(p) ? 'file' : 'dir'}`}>{isFilePath(p) ? '图片' : '文件夹'}</span>
                  <span className="path" title={p}>{p}</span>
                  <button className="mini" onClick={() => window.electronAPI.showInExplorer(p)}>定位</button>
                  <button className="mini danger" onClick={() => onChange(paths.filter((_, j) => j !== i))}>移除</button>
                </div>
              ))}
            </div>
          )}

        <div className="row modal-actions">
          <button onClick={onAddFiles}>添加图片</button>
          <button onClick={onAddFolder}>添加文件夹</button>
          {paths.length > 0 && <button className="danger" onClick={() => onChange([])}>清空全部</button>}
          <button className="primary" onClick={onClose}>完成</button>
        </div>
      </div>
    </div>
  )
}

/** 按当前放入方式/输出模式/日期，重算单张图片的目标路径（前端即时预览用） */
function recomputeTargetPath(entry: PhotoEntry, outputRoot: string, placement: AddPlacement, outputMode: OutputMode): string {
  const fileName = basename(entry.sourcePath)
  let dir: string
  if (outputMode === OutputMode.InPlace) {
    dir = dirnameStr(entry.sourcePath)
    if (placement !== AddPlacement.Flat) dir = `${dir}/${entry.date}`
  } else {
    dir = outputRoot
    if (placement !== AddPlacement.Flat) dir = `${dir}/${entry.date}`
  }
  return `${dir}/${fileName}`
}

export default function App() {
  const [tab, setTab] = useState<Tab>('organize')
  const [aboutOpen, setAboutOpen] = useState(false)
  const [toast, setToast] = useState<string>('')

  const notify = (msg: string) => {
    setToast(msg)
    window.setTimeout(() => setToast(''), 4000)
  }

  return (
    <div className="app">
      <header className="topbar">
        <h1>PictureManager</h1>
        <div className="top-actions">
          <button title="仅能撤销最近一次操作" onClick={async () => {
            const ok = await window.electronAPI.undo()
            notify(ok ? '已撤销上一次操作' : '没有可撤销的操作，或部分文件已被改动')
          }}>撤销上一次</button>
          <button className="about-btn" onClick={() => setAboutOpen(true)}>关于 / 说明</button>
        </div>
      </header>

      <nav className="tabs">
        <button className={tab === 'organize' ? 'active' : ''} onClick={() => setTab('organize')}>整理新照片</button>
        <button className={tab === 'append' ? 'active' : ''} onClick={() => setTab('append')}>添加到文件夹</button>
      </nav>

      <main className="content">
        {tab === 'organize'
          ? <OrganizePanel notify={notify} />
          : <AppendPanel notify={notify} />}
      </main>

      {aboutOpen && <AboutCard onClose={() => setAboutOpen(false)} />}
      {toast && <div className="toast">{toast}</div>}
    </div>
  )
}

function ConfigFields({ config, setConfig }: {
  config: OrganizeConfig
  setConfig: (c: OrganizeConfig) => void
}) {
  const patch = (p: Partial<OrganizeConfig>) => setConfig({ ...config, ...p })
  return (
    <div className="config-grid">
      <label>输出模式
        <select value={config.outputMode} onChange={(e) => patch({ outputMode: e.target.value as OutputMode })}>
          <option value={OutputMode.CopyToNew}>② 指定路径新建（复制，原文件不动）</option>
          <option value={OutputMode.InPlace}>① 原目录整理（移动，不复制）</option>
        </select>
      </label>
      <label>日期策略
        <select value={config.sortStrategy} onChange={(e) => patch({ sortStrategy: e.target.value as SortStrategy })}>
          <option value={SortStrategy.CaptureFirst}>A 拍摄优先（推荐）</option>
          <option value={SortStrategy.SaveTimeFirst}>B 保存时间优先</option>
        </select>
      </label>
      <label>命名形式
        <select value={config.namingMode} onChange={(e) => patch({ namingMode: e.target.value as NamingMode })}>
          <option value={NamingMode.FolderOnly}>仅文件夹（文件名不变）</option>
          <option value={NamingMode.FolderAndFile}>文件夹 + 文件重命名</option>
        </select>
      </label>
      {config.namingMode === NamingMode.FolderAndFile && (
        <label>命名模板
          <input value={config.nameTemplate || ''} placeholder="{YYYY-MM-DD}_{原文件名}"
            onChange={(e) => patch({ nameTemplate: e.target.value })} />
        </label>
      )}
      <label className="checkbox">
        <input type="checkbox" checked={config.recursive} onChange={(e) => patch({ recursive: e.target.checked })} />
        递归扫描子文件夹
      </label>
      <label>非图片元素
        <select value={config.nonImageStrategy || NonImageStrategy.Skip}
          onChange={(e) => patch({ nonImageStrategy: e.target.value as NonImageStrategy })}>
          <option value={NonImageStrategy.Skip}>跳过（仅提示）</option>
          <option value={NonImageStrategy.ToOtherFolder}>按修改时间归入"其他文件/"</option>
          <option value={NonImageStrategy.ByExtension}>按扩展名归入"其他文件/"</option>
        </select>
      </label>
    </div>
  )
}

function PreviewTable({ entries, setEntries, onShowInExplorer, onRecalc, dateEditable = true }: {
  entries: PhotoEntry[]
  setEntries: (e: PhotoEntry[]) => void
  onShowInExplorer: (path: string) => void
  /** 改日期后重算目标路径（可选，由各面板提供） */
  onRecalc?: (entry: PhotoEntry, date: string) => string
  /**
   * 日期是否可编辑。
   * 日期栏的语义是「这张照片放进哪个日期子文件夹」，
   * 当用户选择「直接放入目标文件夹」时不建日期子目录，日期不参与分类，故置灰禁用避免歧义。
   */
  dateEditable?: boolean
}) {
  const [filter, setFilter] = useState<string>('all')
  const shown = entries.filter((e) => filter === 'all' || e.confidence === filter)
  const patch = (id: string, p: Partial<PhotoEntry>) => setEntries(entries.map((e) => {
    if (e.id !== id) return e
    const next = { ...e, ...p }
    // 改日期时同步重算目标路径
    if ('date' in p && onRecalc) next.targetPath = onRecalc(next, p.date!)
    return next
  }))

  return (
    <div className="preview">
      <div className="preview-toolbar">
        <span>共 {entries.length} 张</span>
        <span className="dot high">高 {entries.filter((e) => e.confidence === Confidence.High).length}</span>
        <span className="dot medium">中 {entries.filter((e) => e.confidence === Confidence.Medium).length}</span>
        <span className="dot low">低 {entries.filter((e) => e.confidence === Confidence.Low).length}</span>
        <span className="dot conflict">冲突 {entries.filter((e) => e.confidence === Confidence.Conflict).length}</span>
        <select value={filter} onChange={(e) => setFilter(e.target.value)}>
          <option value="all">全部</option>
          <option value={Confidence.High}>仅高</option>
          <option value={Confidence.Medium}>仅中</option>
          <option value={Confidence.Low}>仅低</option>
          <option value={Confidence.Conflict}>仅冲突</option>
        </select>
        <button onClick={() => setEntries(entries.map((e) => ({ ...e, selected: true })))}>全选</button>
        <button onClick={() => setEntries(entries.map((e) => ({ ...e, selected: false })))}>全不选</button>
      </div>
      <div className="table-wrap">
        <table className="preview-table">
          <thead>
            <tr><th></th><th>缩略图</th><th>源文件名</th><th>{dateEditable ? '日期（可改）' : '日期（不参与分类）'}</th><th>来源</th><th>置信度</th><th>目标路径</th><th></th></tr>
          </thead>
          <tbody>
            {shown.map((e) => (
              <tr key={e.id} className={e.manual ? 'manual-row' : ''}>
                <td><input type="checkbox" checked={e.selected} onChange={(ev) => patch(e.id, { selected: ev.target.checked })} /></td>
                <td>
                  {e.thumbnail
                    ? <img src={e.thumbnail} className="thumb" alt="缩略图" />
                    : <div className="thumb placeholder">无预览</div>}
                </td>
                <td className="path" title={e.sourcePath}>{basename(e.sourcePath)}</td>
                <td>
                  {dateEditable
                    ? <input className="date-input" value={e.date} title="修改后会重新计算目标文件夹"
                        onChange={(ev) => patch(e.id, { date: ev.target.value })} />
                    : <input className="date-input readonly" value={e.date} disabled
                        title="当前放入方式为「直接放入目标文件夹」，不新建日期子文件夹，因此日期不参与分类" />}
                </td>
                <td>{sourceLabel[e.source] || e.source}{e.manual ? ' ·手动' : ''}</td>
                <td><span className={`badge ${e.confidence}`}>{confidenceLabel[e.confidence] || e.confidence}</span></td>
                <td className="path" title={e.targetPath}>
                  {e.targetPath}
                  {e.dateMismatch && (
                    <span className="date-mismatch" title={`图片自身日期 ${e.date} 与目标文件夹 ${e.targetFolderDate} 不符；按你的选择直接放入，请自行确认`}>
                      ⚠ 日期不符（{e.date} ≠ {e.targetFolderDate}）
                    </span>
                  )}
                </td>
                <td><button className="mini" onClick={() => onShowInExplorer(e.sourcePath)}>定位</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function useRunner(notify: (m: string) => void) {
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState<ProgressInfo>({ done: 0, total: 0 })
  const [report, setReport] = useState<RunReport | null>(null)

  useEffect(() => {
    window.electronAPI.onProgress((info) => setProgress(info))
  }, [])

  const run = useCallback(async (entries: PhotoEntry[], config: OrganizeConfig) => {
    setRunning(true)
    setReport(null)
    setProgress({ done: 0, total: entries.filter((e) => e.selected).length })
    try {
      const r = await window.electronAPI.run(entries, config)
      setReport(r)
      notify(`完成：成功 ${r.succeeded} / 失败 ${r.failed} / 跳过 ${r.skipped}。可点顶部「撤销上一次」回退本次。`)
    } catch (e) {
      notify(`执行失败：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setRunning(false)
    }
  }, [notify])

  const cancel = useCallback(async () => {
    await window.electronAPI.cancel()
    notify('已请求取消，正在回滚…')
  }, [notify])

  return { running, progress, report, setReport, run, cancel }
}

function ReportPanel({ report, onClose }: { report: RunReport; onClose: () => void }) {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="card report" onClick={(e) => e.stopPropagation()}>
        <h2>执行结果</h2>
        <p>成功 {report.succeeded} · 失败 {report.failed} · 跳过 {report.skipped}</p>
        {report.errors.length > 0 && (
          <>
            <h3>异常文件</h3>
            <ul className="error-list">
              {report.errors.map((e, i) => <li key={i}><b>{e.name}</b><br /><code>{e.path}</code><br /><span>{e.reason}</span></li>)}
            </ul>
          </>
        )}
        <button onClick={onClose}>关闭</button>
      </div>
    </div>
  )
}

function ProgressBar({ progress, onCancel }: { progress: ProgressInfo; onCancel: () => void }) {
  const pct = progress.total ? Math.round(progress.done / progress.total * 100) : 0
  return (
    <div className="progress">
      <div className="progress-text">正在整理 {progress.done}/{progress.total}（请勿关闭或退出工具）</div>
      <div className="progress-track"><div className="progress-fill" style={{ width: `${pct}%` }} /></div>
      <button onClick={onCancel}>取消（将回滚本次变化）</button>
    </div>
  )
}

function OrganizePanel({ notify }: { notify: (m: string) => void }) {
  const [config, setConfig] = useState<OrganizeConfig>({
    inputPaths: [], outputMode: OutputMode.CopyToNew, sortStrategy: SortStrategy.CaptureFirst,
    namingMode: NamingMode.FolderOnly, recursive: true, nonImageStrategy: NonImageStrategy.Skip,
    onTargetExists: 'rename'
  })
  const [entries, setEntries] = useState<PhotoEntry[]>([])
  const [scanResult, setScanResult] = useState<ScanResult | null>(null)
  const [scanned, setScanned] = useState(false)
  const [scanning, setScanning] = useState(false)
  const [inputsOpen, setInputsOpen] = useState(false)
  const { running, progress, report, setReport, run, cancel } = useRunner(notify)

  const addDir = async () => {
    const d = await window.electronAPI.selectDirectory()
    if (!d) return
    const next = mergePaths(config.inputPaths, [d])
    setConfig((c) => ({ ...c, inputPaths: next }))
    if (next.length === config.inputPaths.length) notify('该文件夹已在列表中，未重复添加')
  }
  const addFiles = async () => {
    const fs = await window.electronAPI.selectFiles()
    if (!fs.length) return
    const next = mergePaths(config.inputPaths, fs)
    const skipped = fs.length - (next.length - config.inputPaths.length)
    setConfig((c) => ({ ...c, inputPaths: next }))
    if (skipped > 0) notify(`已添加 ${fs.length - skipped} 项，跳过 ${skipped} 个重复项`)
  }
  const pickOutput = async () => {
    const d = await window.electronAPI.selectDirectory()
    if (d) setConfig((c) => ({ ...c, outputDir: d }))
  }

  const doScan = async () => {
    if (!config.inputPaths.length) { notify('请先选择照片或文件夹'); return }
    if (config.outputMode === OutputMode.CopyToNew && !config.outputDir) { notify('请选择输出文件夹'); return }
    setScanning(true)
    setScanned(false)
    try {
      const r = await window.electronAPI.scan(config)
      setScanResult(r)
      setEntries(r.images)
      setScanned(true)
      if (!r.images.length) notify('没有可整理的文件')
      else notify(`识别到 ${r.images.length} 张图片，请在下方预览并确认`)
      if (r.nonImages.length) notify(`发现 ${r.nonImages.length} 个非图片文件：${r.nonImages.slice(0, 3).map(basename).join('、')}${r.nonImages.length > 3 ? '…' : ''}`)
      if (r.disk && !r.disk.enough) notify(`磁盘空间可能不足：需要约 ${fmtSize(r.disk.required)}`)
    } catch (e) {
      notify(`预览失败：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setScanning(false)
    }
  }

  return (
    <section>
      <div className="row">
        <button onClick={addDir}>选择文件夹</button>
        <button onClick={addFiles}>选择照片文件</button>
        <button className="view-selected" onClick={() => setInputsOpen(true)} disabled={!config.inputPaths.length}>
          查看已选（{config.inputPaths.length}）
        </button>
        <span className="hint">可多次添加，重复路径自动跳过</span>
      </div>
      {config.inputPaths.length > 0 && (
        <div className="path-list">
          {config.inputPaths.map((p, i) => <div key={i}>{p}
            <button className="mini" onClick={() => setConfig((c) => ({ ...c, inputPaths: c.inputPaths.filter((_, j) => j !== i) }))}>移除</button>
          </div>)}
        </div>
      )}

      <ConfigFields config={config} setConfig={setConfig} />

      {config.outputMode === OutputMode.CopyToNew && (
        <div className="row">
          <button onClick={pickOutput}>选择输出文件夹</button>
          <span>{config.outputDir || '未选择（默认：输入文件夹旁）'}</span>
          <span className="warn">请勿把输出放到系统位置或重要文件夹</span>
        </div>
      )}
      {config.outputMode === OutputMode.InPlace && <p className="warn">原地整理会移动文件（不复制），请确认已备份重要照片。</p>}
      {scanResult?.disk && (
        <p className="hint">空间预检：约需 {fmtSize(scanResult.disk!.required)}，可用 {fmtSize(scanResult.disk!.available)} {scanResult.disk!.enough ? '✓' : '⚠ 不足'}</p>
      )}

      <div className="row">
        <button className="primary" onClick={doScan} disabled={scanning}>{scanning ? '识别中…（请稍候）' : '预览'}</button>
        {scanning && <span className="hint">正在读取每张照片的日期，图片多时需要一点时间…</span>}
      </div>

      {scanned && <PreviewTable entries={entries} setEntries={setEntries} onShowInExplorer={(p) => window.electronAPI.showInExplorer(p)}
        onRecalc={(entry, date) => recomputeTargetPath({ ...entry, date }, config.outputDir || '', AddPlacement.ByDate, config.outputMode)} />}

      {scanned && entries.length > 0 && !running && (
        <div className="row">
          {config.outputMode === OutputMode.InPlace && <span className="warn">移动不可自动恢复，确认继续？</span>}
          <button className="primary" onClick={() => run(entries, config)}>确认执行</button>
        </div>
      )}
      {running && <ProgressBar progress={progress} onCancel={cancel} />}
      {report && <ReportPanel report={report} onClose={() => setReport(null)} />}
      {inputsOpen && <SelectedInputs
        paths={config.inputPaths}
        onChange={(next) => setConfig((c) => ({ ...c, inputPaths: next }))}
        onClose={() => setInputsOpen(false)}
        onAddFiles={() => void addFiles()}
        onAddFolder={() => void addDir()}
      />}
    </section>
  )
}

function AppendPanel({ notify }: { notify: (m: string) => void }) {
  const [targetDir, setTargetDir] = useState('')
  const [mode, setMode] = useState<'follow' | 'manual'>('follow')
  const [placement, setPlacement] = useState<AddPlacement>(AddPlacement.ByDate)
  const [config, setConfig] = useState<OrganizeConfig>({
    inputPaths: [], outputMode: OutputMode.CopyToNew, sortStrategy: SortStrategy.CaptureFirst,
    namingMode: NamingMode.FolderOnly, recursive: true, nonImageStrategy: NonImageStrategy.Skip
  })
  const [entries, setEntries] = useState<PhotoEntry[]>([])
  const [scanned, setScanned] = useState(false)
  const [scanning, setScanning] = useState(false)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [inputsOpen, setInputsOpen] = useState(false)
  const { running, progress, report, setReport, run, cancel } = useRunner(notify)

  const pickTarget = async () => {
    const d = await window.electronAPI.selectDirectory()
    if (d) {
      setTargetDir(d)
      // 无论是否识别到现有格式，都必须设置 outputDir，否则执行时清单目录为空
      setConfig((c) => ({ ...c, outputDir: d }))
      const fmt = await window.electronAPI.readDirFormat(d)
      if (fmt) setConfig((c) => ({ ...c, ...fmt, outputDir: d }))
    }
  }
  const addImages = async () => {
    const fs = await window.electronAPI.selectFiles()
    if (!fs.length) return
    const next = mergePaths(config.inputPaths, fs)
    const skipped = fs.length - (next.length - config.inputPaths.length)
    setConfig((c) => ({ ...c, inputPaths: next }))
    if (skipped > 0) notify(`已添加 ${fs.length - skipped} 项，跳过 ${skipped} 个重复项`)
  }
  const addDir = async () => {
    const d = await window.electronAPI.selectDirectory()
    if (!d) return
    const next = mergePaths(config.inputPaths, [d])
    setConfig((c) => ({ ...c, inputPaths: next }))
    if (next.length === config.inputPaths.length) notify('该文件夹已在列表中，未重复添加')
  }

  const doScan = async () => {
    if (!targetDir) { notify('请先选择目标文件夹'); return }
    if (!config.inputPaths.length) { notify('请先选择要添加的图片'); return }
    setScanning(true)
    setScanned(false)
    try {
      const cfg = { ...config, outputDir: targetDir, outputMode: OutputMode.CopyToNew, addPlacement: placement }
      const r = await window.electronAPI.scan(cfg)
      setEntries(r.images)
      setScanned(true)
      if (!r.images.length) notify('没有可添加的图片')
      else notify(`识别到 ${r.images.length} 张图片，请在下方预览并确认`)
      if (r.nonImages.length) notify(`发现 ${r.nonImages.length} 个非图片文件（不在白名单，已跳过）`)
    } catch (e) {
      notify(`预览失败：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setScanning(false)
    }
  }

  return (
    <section>
      <div className="row">
        <button onClick={pickTarget}>选择目标文件夹（必填）</button>
        <span>{targetDir || '未选择'}</span>
        <span className="warn">系统位置或重要文件夹请勿选</span>
      </div>
      <div className="row">
        <button onClick={addImages}>选择图片</button>
        <button onClick={addDir}>选择文件夹</button>
        <button className="view-selected" onClick={() => setInputsOpen(true)} disabled={!config.inputPaths.length}>
          查看已选（{config.inputPaths.length}）
        </button>
      </div>

      <div className="config-grid">
        <label>配置模式
          <select value={mode} onChange={(e) => setMode(e.target.value as 'follow' | 'manual')}>
            <option value="follow">按钮1：跟随目标文件夹现有格式</option>
            <option value="manual">按钮2：手动 + 自动（一步弹窗）</option>
          </select>
        </label>
        <label>后缀白名单（选填，逗号分隔）
          <input placeholder="jpg,png,heic,cr2" value={(config.suffixWhitelist || []).join(',')}
            onChange={(e) => setConfig((c) => ({ ...c, suffixWhitelist: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) }))} />
        </label>
        <label>放入方式
          <select value={placement} onChange={(e) => {
            const p = e.target.value as AddPlacement
            setPlacement(p)
            // 「直接放入」没有子文件夹可指定，手动弹窗失去意义，直接关掉
            if (p === AddPlacement.Flat) setPickerOpen(false)
            // 立即重算所有条目的目标路径，无需重新点预览
            setEntries((prev) => prev.map((entry) => ({
              ...entry,
              targetPath: recomputeTargetPath(entry, targetDir, p, OutputMode.CopyToNew)
            })))
          }}>
            <option value={AddPlacement.ByDate}>按图片日期在目标文件夹内新建子文件夹</option>
            <option value={AddPlacement.Flat}>直接放入目标文件夹（无视日期差异，不再建子目录）</option>
          </select>
        </label>
      </div>

      {placement === AddPlacement.Flat && (
        <p className="hint">
          已选择「直接放入」：图片会直接放进目标文件夹，<b>不再新建日期子文件夹</b>，
          因此预览表里的日期栏已禁用（仅作参考）。
        </p>
      )}

      <div className="row">
        <button className="primary" onClick={doScan} disabled={scanning}>{scanning ? '识别中…（请稍候）' : '预览'}</button>
        {scanning && <span className="hint">正在读取日期，请稍候…</span>}
        {mode === 'manual' && scanned && (
          <button
            onClick={() => setPickerOpen(true)}
            disabled={placement === AddPlacement.Flat}
            title={placement === AddPlacement.Flat
              ? '当前为「直接放入目标文件夹」，没有子文件夹可指定，故不可用；如需按文件夹归档请切换放入方式'
              : '为指定图片手工填写目标子文件夹'}>
            打开手动配置弹窗
          </button>
        )}
      </div>

      {scanned && <PreviewTable entries={entries} setEntries={setEntries} onShowInExplorer={(p) => window.electronAPI.showInExplorer(p)}
        dateEditable={placement !== AddPlacement.Flat}
        onRecalc={(entry, date) => recomputeTargetPath({ ...entry, date }, targetDir, placement, OutputMode.CopyToNew)} />}
      {scanned && entries.length > 0 && !running && (
        <div className="row"><button className="primary" onClick={() => run(entries, { ...config, outputDir: targetDir, outputMode: OutputMode.CopyToNew, addPlacement: placement })}>确认执行</button></div>
      )}
      {running && <ProgressBar progress={progress} onCancel={cancel} />}
      {report && <ReportPanel report={report} onClose={() => setReport(null)} />}
      {pickerOpen && <ManualPicker
        entries={entries}
        setEntries={setEntries}
        targetDir={targetDir}
        onClose={() => setPickerOpen(false)}
      />}
      {inputsOpen && <SelectedInputs
        paths={config.inputPaths}
        onChange={(next) => setConfig((c) => ({ ...c, inputPaths: next }))}
        onClose={() => setInputsOpen(false)}
        onAddFiles={() => void addImages()}
        onAddFolder={() => void addDir()}
      />}
    </section>
  )
}

/** 手动指定弹窗（顶层独立组件，避免每次渲染被重建导致输入框失焦） */
function ManualPicker({ entries, setEntries, targetDir, onClose }: {
  entries: PhotoEntry[]
  setEntries: Dispatch<SetStateAction<PhotoEntry[]>>
  targetDir: string
  onClose: () => void
}) {
  // 每个输入框的值由局部 state 管理，输入时不触发父组件重渲染导致失焦
  const [values, setValues] = useState<Record<string, string>>({})

  const onValueChange = (id: string, v: string) => {
    setValues((prev) => ({ ...prev, [id]: v }))
    // 即时同步到 entries（供预览表与执行使用），用函数式更新避免闭包读到旧 entries
    setEntries((prev: PhotoEntry[]) => prev.map((x) => {
      if (x.id !== id) return x
      return {
        ...x,
        manual: !!v.trim(),
        date: v.trim() || x.date,
        targetPath: v.trim() ? `${targetDir}/${v.trim()}/${basename(x.sourcePath)}` : x.targetPath
      }
    }))
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="card picker" onClick={(e) => e.stopPropagation()}>
        <h2>手动指定（被点选图片不参与自动归类）</h2>
        <p className="hint">必填：指定文件夹。其余选填。填了文件夹的图片将退出自动归类，未填的按时间戳自动归入。</p>
        <div className="picker-list">
          {entries.map((e) => (
            <div key={e.id} className="picker-item">
              {e.thumbnail ? <img src={e.thumbnail} className="thumb" alt="" /> : <div className="thumb placeholder">无预览</div>}
              <div className="picker-fields">
                <div>{basename(e.sourcePath)}</div>
                <input
                  placeholder="目标文件夹（必填，如 2023-01-02）"
                  value={values[e.id] ?? ''}
                  onChange={(ev) => onValueChange(e.id, ev.target.value)}
                />
              </div>
              <button className="mini" onClick={() => window.electronAPI.showInExplorer(e.sourcePath)}>定位</button>
            </div>
          ))}
        </div>
        <button className="primary" onClick={onClose}>确定（确认时合并）</button>
      </div>
    </div>
  )
}

function AboutCard({ onClose }: { onClose: () => void }) {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="card" onClick={(e) => e.stopPropagation()}>
        <h2>关于 / 说明</h2>
        <ul>
          <li>置信度颜色：<b className="high">绿</b>=EXIF拍摄（高），<b className="medium">黄</b>=其他来源（中），<b className="low">红</b>=修改时间（低），<b className="conflict">紫</b>=日期冲突。低/冲突默认不勾选。</li>
          <li>7 类时间来源（可信度从高到低）：EXIF拍摄 → EXIF数字化 → EXIF时间 → XMP → 文件名日期 → 创建时间 → 修改时间；两来源相差 &gt; 1 天标冲突。</li>
          <li>未识别与异常日期统一记为 <code>0000-00-00</code>，归入同名文件夹集中处理。</li>
          <li>工具只依据<b>文件名中标明的日期</b>做自动分类；若命名导致看不出日期，则不参与自动分类，需手动指定。</li>
          <li>命名格式不限制，但系统非法字符与超长名称会被过滤或提示。</li>
          <li>输出模式：① 原地整理=移动不复制；② 指定路径=复制。由所选模式决定，与路径无关。</li>
          <li>「添加到文件夹」的放入方式：<b>按图片日期新建子文件夹</b>＝在目标文件夹内按各图日期继续分层；<b>直接放入</b>＝无视日期差异直接进目标文件夹，不再建子目录（日期不符会在预览标注，由你自行确认）。</li>
          <li>撤销<b>仅最近一次</b>；不做中断恢复，执行中请勿关闭工具；点取消会回滚本次变化。</li>
          <li>纯本地：不联网、不登录、不收集任何信息。</li>
        </ul>
        <button onClick={onClose}>关闭</button>
      </div>
    </div>
  )
}
