/**
 * 主窗口 UI
 * 两个并列入口：整理新照片 / 添加到文件夹；关于卡片；结果报告与撤销。
 * 所有可见文案经 src/shared/i18n.ts 切换中英，业务逻辑不随语言变化。
 */
import {
  createContext, useCallback, useContext, useEffect, useState,
  type Dispatch, type ReactNode, type SetStateAction
} from 'react'
import {
  OutputMode, NamingMode, SortStrategy, NonImageStrategy, Confidence, DateSource, AddPlacement,
  type PhotoEntry, type OrganizeConfig, type ScanResult, type RunReport,
  type ProgressInfo
} from '../../shared/types'
import { t, detectLang, type Lang, type MessageKey } from '../../shared/i18n'

type Tab = 'organize' | 'append'

const LANG_KEY = 'picture-manager-lang'
const LangContext = createContext<Lang>('zh-CN')

function useI18n() {
  const lang = useContext(LangContext)
  const tr = useCallback(
    (key: MessageKey, vars?: Record<string, string | number>) => t(lang, key, vars),
    [lang]
  )
  return { lang, tr }
}

/** 极简富文本：**粗体**、`代码`、[[high]]彩色[[/]]。内容来自本地词库，非用户输入。 */
function Rich({ text }: { text: string }) {
  const nodes: ReactNode[] = []
  const tokens = text.split(/(\[\[(?:high|medium|low|conflict)\]\]|\[\[\/\]\]|\*\*|`)/g)
  let mode: 'b' | 'code' | 'high' | 'medium' | 'low' | 'conflict' | null = null
  let i = 0
  for (const part of tokens) {
    if (!part) continue
    if (part === '**') { mode = mode === 'b' ? null : 'b'; continue }
    if (part === '`') { mode = mode === 'code' ? null : 'code'; continue }
    if (part === '[[/]]') { mode = null; continue }
    const colored = /^\[\[(high|medium|low|conflict)\]\]$/.exec(part)
    if (colored) { mode = colored[1] as 'high' | 'medium' | 'low' | 'conflict'; continue }
    const key = i++
    if (mode && mode !== 'b' && mode !== 'code') nodes.push(<b key={key} className={mode}>{part}</b>)
    else if (mode === 'b') nodes.push(<b key={key}>{part}</b>)
    else if (mode === 'code') nodes.push(<code key={key}>{part}</code>)
    else nodes.push(<span key={key}>{part}</span>)
  }
  return <>{nodes}</>
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
  const { tr } = useI18n()
  const fileCount = paths.filter(isFilePath).length
  const dirCount = paths.length - fileCount
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="card inputs-card" onClick={(e) => e.stopPropagation()}>
        <h2>{tr('selectedTitle', { n: paths.length })}</h2>
        <p className="hint">
          {tr('selectedSummary', { n: paths.length, f: fileCount, d: dirCount })}
        </p>

        {paths.length === 0
          ? <p className="hint empty-tip">{tr('selectedEmpty')}</p>
          : (
            <div className="inputs-list">
              {paths.map((p, i) => (
                <div className="inputs-item" key={`${p}#${i}`}>
                  <span className={`kind ${isFilePath(p) ? 'file' : 'dir'}`}>
                    {isFilePath(p) ? tr('kindFile') : tr('kindDir')}
                  </span>
                  <span className="path" title={p}>{p}</span>
                  <button className="mini" onClick={() => window.electronAPI.showInExplorer(p)}>{tr('locate')}</button>
                  <button className="mini danger" onClick={() => onChange(paths.filter((_, j) => j !== i))}>{tr('remove')}</button>
                </div>
              ))}
            </div>
          )}

        <div className="row modal-actions">
          <button onClick={onAddFiles}>{tr('addImages')}</button>
          <button onClick={onAddFolder}>{tr('addFolder')}</button>
          {paths.length > 0 && <button className="danger" onClick={() => onChange([])}>{tr('clearAll')}</button>}
          <button className="primary" onClick={onClose}>{tr('done')}</button>
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
  const [lang, setLangState] = useState<Lang>(() => {
    try {
      const saved = localStorage.getItem(LANG_KEY)
      if (saved === 'zh-CN' || saved === 'en') return saved
    } catch { /* localStorage 不可用时按系统语言 */ }
    return detectLang()
  })

  const syncLang = useCallback((next: Lang) => {
    setLangState(next)
    try { localStorage.setItem(LANG_KEY, next) } catch { /* 忽略存储失败 */ }
    void window.electronAPI.setLanguage(next)
  }, [])

  useEffect(() => { void window.electronAPI.setLanguage(lang) }, [lang])

  const notify = (msg: string) => {
    setToast(msg)
    window.setTimeout(() => setToast(''), 4000)
  }

  // App 自身在 Provider 之上，直接按 state 取词；子组件用 useI18n()
  const tr = useCallback(
    (key: MessageKey, vars?: Record<string, string | number>) => t(lang, key, vars),
    [lang]
  )
  const toggleLang = () => syncLang(lang === 'zh-CN' ? 'en' : 'zh-CN')

  return (
    <LangContext.Provider value={lang}>
      <div className="app">
        <header className="topbar">
          <h1>PictureManager</h1>
          <div className="top-actions">
            <button id="lang-toggle" onClick={toggleLang} title="Switch language / 切换语言">
              {lang === 'zh-CN' ? tr('switchToEnglish') : tr('switchToChinese')}
            </button>
            <button title={tr('undoTitle')} onClick={async () => {
              const ok = await window.electronAPI.undo()
              notify(ok ? tr('undoOk') : tr('undoFail'))
            }}>{tr('undo')}</button>
            <button className="about-btn" onClick={() => setAboutOpen(true)}>{tr('about')}</button>
          </div>
        </header>

        <nav className="tabs">
          <button className={tab === 'organize' ? 'active' : ''} onClick={() => setTab('organize')}>{tr('tabOrganize')}</button>
          <button className={tab === 'append' ? 'active' : ''} onClick={() => setTab('append')}>{tr('tabAppend')}</button>
        </nav>

        <main className="content">
          {tab === 'organize'
            ? <OrganizePanel notify={notify} />
            : <AppendPanel notify={notify} />}
        </main>

        {aboutOpen && <AboutCard onClose={() => setAboutOpen(false)} />}
        {toast && <div className="toast">{toast}</div>}
      </div>
    </LangContext.Provider>
  )
}

function ConfigFields({ config, setConfig }: {
  config: OrganizeConfig
  setConfig: (c: OrganizeConfig) => void
}) {
  const { tr } = useI18n()
  const patch = (p: Partial<OrganizeConfig>) => setConfig({ ...config, ...p })
  return (
    <div className="config-grid">
      <label>{tr('outputMode')}
        <select value={config.outputMode} onChange={(e) => patch({ outputMode: e.target.value as OutputMode })}>
          <option value={OutputMode.CopyToNew}>{tr('modeCopy')}</option>
          <option value={OutputMode.InPlace}>{tr('modeInPlace')}</option>
        </select>
      </label>
      <label>{tr('dateStrategy')}
        <select value={config.sortStrategy} onChange={(e) => patch({ sortStrategy: e.target.value as SortStrategy })}>
          <option value={SortStrategy.CaptureFirst}>{tr('strategyCapture')}</option>
          <option value={SortStrategy.SaveTimeFirst}>{tr('strategySave')}</option>
        </select>
      </label>
      <label>{tr('namingMode')}
        <select value={config.namingMode} onChange={(e) => patch({ namingMode: e.target.value as NamingMode })}>
          <option value={NamingMode.FolderOnly}>{tr('nameFolderOnly')}</option>
          <option value={NamingMode.FolderAndFile}>{tr('nameFolderAndFile')}</option>
        </select>
      </label>
      {config.namingMode === NamingMode.FolderAndFile && (
        <label>{tr('nameTemplate')}
          {/* 模板 token 会写进文件名，两种语言都保持原样 */}
          <input value={config.nameTemplate || ''} placeholder="{YYYY-MM-DD}_{原文件名}"
            onChange={(e) => patch({ nameTemplate: e.target.value })} />
        </label>
      )}
      <label className="checkbox">
        <input type="checkbox" checked={config.recursive} onChange={(e) => patch({ recursive: e.target.checked })} />
        {tr('recursive')}
      </label>
      <label>{tr('nonImage')}
        <select value={config.nonImageStrategy || NonImageStrategy.Skip}
          onChange={(e) => patch({ nonImageStrategy: e.target.value as NonImageStrategy })}>
          <option value={NonImageStrategy.Skip}>{tr('nonImageSkip')}</option>
          <option value={NonImageStrategy.ToOtherFolder}>{tr('nonImageOtherMtime')}</option>
          <option value={NonImageStrategy.ByExtension}>{tr('nonImageOtherExt')}</option>
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
  const { tr } = useI18n()
  const [filter, setFilter] = useState<string>('all')
  const shown = entries.filter((e) => filter === 'all' || e.confidence === filter)
  const patch = (id: string, p: Partial<PhotoEntry>) => setEntries(entries.map((e) => {
    if (e.id !== id) return e
    const next = { ...e, ...p }
    // 改日期时同步重算目标路径
    if ('date' in p && onRecalc) next.targetPath = onRecalc(next, p.date!)
    return next
  }))

  const confidenceLabel: Record<string, string> = {
    [Confidence.High]: tr('confHigh'),
    [Confidence.Medium]: tr('confMedium'),
    [Confidence.Low]: tr('confLow'),
    [Confidence.Conflict]: tr('confConflict')
  }
  const sourceLabel: Record<string, string> = {
    [DateSource.ExifDateTimeOriginal]: tr('srcExifOriginal'),
    [DateSource.ExifDateTimeDigitized]: tr('srcExifDigitized'),
    [DateSource.ExifDateTime]: tr('srcExif'),
    [DateSource.XmpSidecar]: tr('srcXmp'),
    [DateSource.Filename]: tr('srcFilename'),
    [DateSource.Birthtime]: tr('srcBirthtime'),
    [DateSource.Mtime]: tr('srcMtime'),
    [DateSource.None]: tr('srcNone')
  }

  return (
    <div className="preview">
      <div className="preview-toolbar">
        <span>{tr('totalPhotos', { n: entries.length })}</span>
        <span className="dot high">{tr('high')} {entries.filter((e) => e.confidence === Confidence.High).length}</span>
        <span className="dot medium">{tr('medium')} {entries.filter((e) => e.confidence === Confidence.Medium).length}</span>
        <span className="dot low">{tr('low')} {entries.filter((e) => e.confidence === Confidence.Low).length}</span>
        <span className="dot conflict">{tr('conflict')} {entries.filter((e) => e.confidence === Confidence.Conflict).length}</span>
        <select value={filter} onChange={(e) => setFilter(e.target.value)}>
          <option value="all">{tr('filterAll')}</option>
          <option value={Confidence.High}>{tr('filterOnlyHigh')}</option>
          <option value={Confidence.Medium}>{tr('filterOnlyMedium')}</option>
          <option value={Confidence.Low}>{tr('filterOnlyLow')}</option>
          <option value={Confidence.Conflict}>{tr('filterOnlyConflict')}</option>
        </select>
        <button onClick={() => setEntries(entries.map((e) => ({ ...e, selected: true })))}>{tr('selectAll')}</button>
        <button onClick={() => setEntries(entries.map((e) => ({ ...e, selected: false })))}>{tr('selectNone')}</button>
      </div>
      <div className="table-wrap">
        <table className="preview-table">
          <thead>
            <tr>
              <th></th><th>{tr('thumb')}</th><th>{tr('sourceName')}</th>
              <th>{dateEditable ? tr('dateEditable') : tr('dateNotUsed')}</th>
              <th>{tr('source')}</th><th>{tr('confidence')}</th><th>{tr('targetPath')}</th><th></th>
            </tr>
          </thead>
          <tbody>
            {shown.map((e) => (
              <tr key={e.id} className={e.manual ? 'manual-row' : ''}>
                <td><input type="checkbox" checked={e.selected} onChange={(ev) => patch(e.id, { selected: ev.target.checked })} /></td>
                <td>
                  {e.thumbnail
                    ? <img src={e.thumbnail} className="thumb" alt={tr('thumb')} />
                    : <div className="thumb placeholder">{tr('noPreview')}</div>}
                </td>
                <td className="path" title={e.sourcePath}>{basename(e.sourcePath)}</td>
                <td>
                  {dateEditable
                    ? <input className="date-input" value={e.date} title={tr('dateInputTitle')}
                        onChange={(ev) => patch(e.id, { date: ev.target.value })} />
                    : <input className="date-input readonly" value={e.date} disabled title={tr('dateDisabledTitle')} />}
                </td>
                <td>{sourceLabel[e.source] || e.source}{e.manual ? tr('manualMark') : ''}</td>
                <td><span className={`badge ${e.confidence}`}>{confidenceLabel[e.confidence] || e.confidence}</span></td>
                <td className="path" title={e.targetPath}>
                  {e.targetPath}
                  {e.dateMismatch && (
                    <span className="date-mismatch" title={tr('dateMismatchTitle', { a: e.date, b: e.targetFolderDate ?? '' })}>
                      {tr('dateMismatch', { a: e.date, b: e.targetFolderDate ?? '' })}
                    </span>
                  )}
                </td>
                <td><button className="mini" onClick={() => onShowInExplorer(e.sourcePath)}>{tr('locate')}</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function useRunner(notify: (m: string) => void) {
  const { tr } = useI18n()
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
      notify(tr('runDone', { s: r.succeeded, f: r.failed, k: r.skipped }))
    } catch (e) {
      notify(tr('runFail', { msg: e instanceof Error ? e.message : String(e) }))
    } finally {
      setRunning(false)
    }
  }, [notify, tr])

  const cancel = useCallback(async () => {
    await window.electronAPI.cancel()
    notify(tr('cancelRequested'))
  }, [notify, tr])

  return { running, progress, report, setReport, run, cancel }
}

function ReportPanel({ report, onClose }: { report: RunReport; onClose: () => void }) {
  const { tr } = useI18n()
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="card report" onClick={(e) => e.stopPropagation()}>
        <h2>{tr('reportTitle')}</h2>
        <p>{tr('reportSummary', { s: report.succeeded, f: report.failed, k: report.skipped })}</p>
        {report.errors.length > 0 && (
          <>
            <h3>{tr('errorsTitle')}</h3>
            <ul className="error-list">
              {report.errors.map((e, i) => <li key={i}><b>{e.name}</b><br /><code>{e.path}</code><br /><span>{e.reason}</span></li>)}
            </ul>
          </>
        )}
        <button onClick={onClose}>{tr('close')}</button>
      </div>
    </div>
  )
}

function ProgressBar({ progress, onCancel }: { progress: ProgressInfo; onCancel: () => void }) {
  const { tr } = useI18n()
  const pct = progress.total ? Math.round(progress.done / progress.total * 100) : 0
  return (
    <div className="progress">
      <div className="progress-text">{tr('progressText', { d: progress.done, t: progress.total })}</div>
      <div className="progress-track"><div className="progress-fill" style={{ width: `${pct}%` }} /></div>
      <button onClick={onCancel}>{tr('cancelProgress')}</button>
    </div>
  )
}

function OrganizePanel({ notify }: { notify: (m: string) => void }) {
  const { tr, lang } = useI18n()
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
  const sep = lang === 'zh-CN' ? '、' : ', '

  const addDir = async () => {
    const d = await window.electronAPI.selectDirectory()
    if (!d) return
    const next = mergePaths(config.inputPaths, [d])
    setConfig((c) => ({ ...c, inputPaths: next }))
    if (next.length === config.inputPaths.length) notify(tr('duplicateFolder'))
  }
  const addFiles = async () => {
    const fs = await window.electronAPI.selectFiles()
    if (!fs.length) return
    const next = mergePaths(config.inputPaths, fs)
    const skipped = fs.length - (next.length - config.inputPaths.length)
    setConfig((c) => ({ ...c, inputPaths: next }))
    if (skipped > 0) notify(tr('addedSkipped', { a: fs.length - skipped, s: skipped }))
  }
  const pickOutput = async () => {
    const d = await window.electronAPI.selectDirectory()
    if (d) setConfig((c) => ({ ...c, outputDir: d }))
  }

  const doScan = async () => {
    if (!config.inputPaths.length) { notify(tr('needInput')); return }
    if (config.outputMode === OutputMode.CopyToNew && !config.outputDir) { notify(tr('needOutput')); return }
    setScanning(true)
    setScanned(false)
    try {
      const r = await window.electronAPI.scan(config)
      setScanResult(r)
      setEntries(r.images)
      setScanned(true)
      if (!r.images.length) notify(tr('noFiles'))
      else notify(tr('recognized', { n: r.images.length }))
      if (r.nonImages.length) {
        const names = r.nonImages.slice(0, 3).map(basename).join(sep)
        notify(tr('nonImages', { n: r.nonImages.length, names, more: r.nonImages.length > 3 ? '…' : '' }))
      }
      if (r.disk && !r.disk.enough) notify(tr('diskLowToast', { n: fmtSize(r.disk.required) }))
    } catch (e) {
      notify(tr('previewFail', { msg: e instanceof Error ? e.message : String(e) }))
    } finally {
      setScanning(false)
    }
  }

  return (
    <section>
      <div className="row">
        <button onClick={addDir}>{tr('selectFolder')}</button>
        <button onClick={addFiles}>{tr('selectPhotos')}</button>
        <button className="view-selected" onClick={() => setInputsOpen(true)} disabled={!config.inputPaths.length}>
          {tr('viewSelected', { n: config.inputPaths.length })}
        </button>
        <span className="hint">{tr('multiHint')}</span>
      </div>
      {config.inputPaths.length > 0 && (
        <div className="path-list">
          {config.inputPaths.map((p, i) => <div key={i}>{p}
            <button className="mini" onClick={() => setConfig((c) => ({ ...c, inputPaths: c.inputPaths.filter((_, j) => j !== i) }))}>{tr('remove')}</button>
          </div>)}
        </div>
      )}

      <ConfigFields config={config} setConfig={setConfig} />

      {config.outputMode === OutputMode.CopyToNew && (
        <div className="row">
          <button onClick={pickOutput}>{tr('pickOutput')}</button>
          <span>{config.outputDir || tr('outputNotSelected')}</span>
          <span className="warn">{tr('outputWarn')}</span>
        </div>
      )}
      {config.outputMode === OutputMode.InPlace && <p className="warn">{tr('inPlaceWarn')}</p>}
      {scanResult?.disk && (
        <p className="hint">{tr('diskCheck', {
          r: fmtSize(scanResult.disk!.required),
          a: fmtSize(scanResult.disk!.available),
          ok: scanResult.disk!.enough ? '✓' : tr('diskLow')
        })}</p>
      )}

      <div className="row">
        <button className="primary" onClick={doScan} disabled={scanning}>{scanning ? tr('scanning') : tr('preview')}</button>
        {scanning && <span className="hint">{tr('scanWait')}</span>}
      </div>

      {scanned && <PreviewTable entries={entries} setEntries={setEntries} onShowInExplorer={(p) => window.electronAPI.showInExplorer(p)}
        onRecalc={(entry, date) => recomputeTargetPath({ ...entry, date }, config.outputDir || '', AddPlacement.ByDate, config.outputMode)} />}

      {scanned && entries.length > 0 && !running && (
        <div className="row">
          {config.outputMode === OutputMode.InPlace && <span className="warn">{tr('moveWarn')}</span>}
          <button className="primary" onClick={() => run(entries, config)}>{tr('confirmRun')}</button>
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
  const { tr } = useI18n()
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
    if (skipped > 0) notify(tr('addedSkipped', { a: fs.length - skipped, s: skipped }))
  }
  const addDir = async () => {
    const d = await window.electronAPI.selectDirectory()
    if (!d) return
    const next = mergePaths(config.inputPaths, [d])
    setConfig((c) => ({ ...c, inputPaths: next }))
    if (next.length === config.inputPaths.length) notify(tr('duplicateFolder'))
  }

  const doScan = async () => {
    if (!targetDir) { notify(tr('needTarget')); return }
    if (!config.inputPaths.length) { notify(tr('needImages')); return }
    setScanning(true)
    setScanned(false)
    try {
      const cfg = { ...config, outputDir: targetDir, outputMode: OutputMode.CopyToNew, addPlacement: placement }
      const r = await window.electronAPI.scan(cfg)
      setEntries(r.images)
      setScanned(true)
      if (!r.images.length) notify(tr('noImagesToAdd'))
      else notify(tr('recognized', { n: r.images.length }))
      if (r.nonImages.length) notify(tr('nonImagesSkipped', { n: r.nonImages.length }))
    } catch (e) {
      notify(tr('previewFail', { msg: e instanceof Error ? e.message : String(e) }))
    } finally {
      setScanning(false)
    }
  }

  return (
    <section>
      <div className="row">
        <button onClick={pickTarget}>{tr('targetFolderRequired')}</button>
        <span>{targetDir || tr('notSelected')}</span>
        <span className="warn">{tr('systemWarn')}</span>
      </div>
      <div className="row">
        <button onClick={addImages}>{tr('selectImages')}</button>
        <button onClick={addDir}>{tr('selectFolder')}</button>
        <button className="view-selected" onClick={() => setInputsOpen(true)} disabled={!config.inputPaths.length}>
          {tr('viewSelected', { n: config.inputPaths.length })}
        </button>
      </div>

      <div className="config-grid">
        <label>{tr('configMode')}
          <select value={mode} onChange={(e) => setMode(e.target.value as 'follow' | 'manual')}>
            <option value="follow">{tr('modeFollow')}</option>
            <option value="manual">{tr('modeManual')}</option>
          </select>
        </label>
        <label>{tr('suffixWhitelist')}
          <input placeholder="jpg,png,heic,cr2" value={(config.suffixWhitelist || []).join(',')}
            onChange={(e) => setConfig((c) => ({ ...c, suffixWhitelist: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) }))} />
        </label>
        <label>{tr('placement')}
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
            <option value={AddPlacement.ByDate}>{tr('placeByDate')}</option>
            <option value={AddPlacement.Flat}>{tr('placeFlat')}</option>
          </select>
        </label>
      </div>

      {placement === AddPlacement.Flat && (
        <p className="hint"><Rich text={tr('flatHint')} /></p>
      )}

      <div className="row">
        <button className="primary" onClick={doScan} disabled={scanning}>{scanning ? tr('scanning') : tr('preview')}</button>
        {scanning && <span className="hint">{tr('scanningShort')}</span>}
        {mode === 'manual' && scanned && (
          <button
            onClick={() => setPickerOpen(true)}
            disabled={placement === AddPlacement.Flat}
            title={placement === AddPlacement.Flat ? tr('manualDisabledTitle') : tr('manualTitleAttr')}>
            {tr('manualPickerBtn')}
          </button>
        )}
      </div>

      {scanned && <PreviewTable entries={entries} setEntries={setEntries} onShowInExplorer={(p) => window.electronAPI.showInExplorer(p)}
        dateEditable={placement !== AddPlacement.Flat}
        onRecalc={(entry, date) => recomputeTargetPath({ ...entry, date }, targetDir, placement, OutputMode.CopyToNew)} />}
      {scanned && entries.length > 0 && !running && (
        <div className="row"><button className="primary" onClick={() => run(entries, { ...config, outputDir: targetDir, outputMode: OutputMode.CopyToNew, addPlacement: placement })}>{tr('confirmRun')}</button></div>
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
  const { tr } = useI18n()
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
        <h2>{tr('manualTitle')}</h2>
        <p className="hint">{tr('manualHint')}</p>
        <div className="picker-list">
          {entries.map((e) => (
            <div key={e.id} className="picker-item">
              {e.thumbnail ? <img src={e.thumbnail} className="thumb" alt="" /> : <div className="thumb placeholder">{tr('noPreview')}</div>}
              <div className="picker-fields">
                <div>{basename(e.sourcePath)}</div>
                <input
                  placeholder={tr('manualPlaceholder')}
                  value={values[e.id] ?? ''}
                  onChange={(ev) => onValueChange(e.id, ev.target.value)}
                />
              </div>
              <button className="mini" onClick={() => window.electronAPI.showInExplorer(e.sourcePath)}>{tr('locate')}</button>
            </div>
          ))}
        </div>
        <button className="primary" onClick={onClose}>{tr('manualConfirm')}</button>
      </div>
    </div>
  )
}

function AboutCard({ onClose }: { onClose: () => void }) {
  const { tr } = useI18n()
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="card" onClick={(e) => e.stopPropagation()}>
        <h2>{tr('aboutTitle')}</h2>
        <ul>
          {([1, 2, 3, 4, 5, 6, 7, 8, 9] as const).map((n) => (
            <li key={n}><Rich text={tr(`about${n}`)} /></li>
          ))}
        </ul>
        <button onClick={onClose}>{tr('close')}</button>
      </div>
    </div>
  )
}
