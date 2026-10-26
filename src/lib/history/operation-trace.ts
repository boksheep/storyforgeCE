/** STEP-1 的只读操作轨迹。撤回日志仍只保存可逆数据快照；这里记录复现路径。 */
export interface OperationTraceEntry {
  at: string
  kind: 'click' | 'change' | 'input' | 'submit' | 'shortcut' | 'drop' | 'drag'
  target: string
  route: string
}

const KEY = 'storyforge-operation-trace-v1'
const LIMIT = 200
const SAFE_LABELS = new Set([
  '重试', '保存', '删除', '编辑', '取消', '确认', '返回', '打开', '关闭', '导入', '导出',
  '下载', '添加关系', '多人关系', '关系图', '列表', 'AI 提取', '撤回', '重做',
  '上一步', '下一步', '清除聚焦', '发送', '提交', '应用', '刷新', '复制', '预览',
  '新建项目', '创建', '开始', '暂停', '继续', '停止', '搜索', '设置', '上传',
  '首页', '项目列表', '章节', '角色设计', '关系网', '世界观', '数据管理', '工作流',
])
const SAFE_ACTION = /^(?:新建|添加|保存|删除|编辑|取消|确认|导入|导出|下载|生成|提取|采纳|打开|关闭|查看|切换|刷新|清空|上传|复制|提交|发送|应用|选择|恢复|备份|检查|继续|重试)(?:项目|章节|卷|角色|关系|多人关系|大纲|正文|地图|文件|日志|诊断包|设置|提示词|候选|结果|快照|备份|数据|世界|任务|工作流|本章|所选内容)?$/
const SAFE_OPERATION_IDS = new Set(['error.retry', 'error.download-diagnostics'])
const SAFE_TYPES = new Set(['button', 'a', 'div', 'span', 'canvas', 'svg', 'form', 'select',
  'input', 'textarea', 'text', 'checkbox', 'radio', 'number', 'file', 'range', 'date', 'search', 'email'])

let entries: OperationTraceEntry[] = []
let installed = false
const recentInputs = new WeakMap<Element, number>()
let pointerStart: { x: number; y: number; target: Element } | null = null

function routePattern(): string {
  return typeof location === 'undefined' ? '' : location.pathname.replace(/\d+/g, ':id').slice(0, 100)
}

function elementPath(element: Element): string {
  const parts: string[] = []
  let current: Element | null = element
  while (current && parts.length < 5 && current !== document.body) {
    const tag = current.tagName.toLowerCase()
    const siblings = current.parentElement
      ? [...current.parentElement.children].filter(child => child.tagName === current!.tagName) : []
    parts.unshift(`${tag}[${Math.max(1, siblings.indexOf(current) + 1)}]`)
    if (tag === 'main' || tag === 'nav' || current.getAttribute('role') === 'dialog') break
    current = current.parentElement
  }
  return parts.join('>')
}

function safeLabel(element: Element): string | null {
  const raw = (element.getAttribute('data-operation') ?? element.getAttribute('aria-label')
    ?? element.getAttribute('title') ?? element.textContent ?? '').replace(/\s+/g, ' ').trim()
  if (element.hasAttribute('data-operation') && SAFE_OPERATION_IDS.has(raw)) return raw
  return SAFE_LABELS.has(raw) || SAFE_ACTION.test(raw) ? raw : null
}

function targetName(element: Element): string {
  const label = safeLabel(element)
  const type = element instanceof HTMLInputElement ? element.type : element.tagName.toLowerCase()
  return `${label ?? type} @ ${elementPath(element)}`.slice(0, 180)
}

export function safeStoredTarget(raw: string): string | null {
  if (/^(Ctrl|Meta)\+[SZY]$/.test(raw)) return raw
  const match = /^(.{1,80}) @ ((?:[a-z]+\[\d+\])(?:>[a-z]+\[\d+\]){0,4})$/.exec(raw)
  if (!match) return null
  const label = match[1]
  const allowed = SAFE_LABELS.has(label) || SAFE_ACTION.test(label)
    || SAFE_OPERATION_IDS.has(label) || SAFE_TYPES.has(label)
    || label === '正文编辑' || label === '画布点击'
  return allowed ? raw : `控件 @ ${match[2]}`
}

function recordOperation(entry: Omit<OperationTraceEntry, 'at' | 'route'>): void {
  entries.push({ at: new Date().toISOString(), route: routePattern(), ...entry })
  if (entries.length > LIMIT) entries = entries.slice(-LIMIT)
  try { sessionStorage.setItem(KEY, JSON.stringify(entries)) } catch { /* 隐私模式不阻断操作 */ }
}

export function getRecentOperations(limit = 100): OperationTraceEntry[] {
  return entries.slice(-Math.max(0, Math.min(limit, LIMIT))).map(entry => ({ ...entry }))
}

export function installOperationTrace(): void {
  if (installed || typeof document === 'undefined') return
  installed = true
  try {
    const saved = JSON.parse(sessionStorage.getItem(KEY) ?? '[]') as unknown
    if (Array.isArray(saved)) entries = saved.flatMap((item: unknown) => {
      if (!item || typeof item !== 'object') return []
      const row = item as Record<string, unknown>
      const target = typeof row.target === 'string' ? safeStoredTarget(row.target) : null
      if (!target || typeof row.at !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(row.at)
        || typeof row.route !== 'string' || !/^\/(?:[a-z-]+|:id)?(?:\/(?:[a-z-]+|:id))*$/.test(row.route)
        || !['click', 'change', 'input', 'submit', 'shortcut', 'drop', 'drag'].includes(String(row.kind))) return []
      return [{ at: row.at, kind: row.kind, target, route: row.route.slice(0, 100) } as OperationTraceEntry]
    }).slice(-LIMIT)
  } catch { entries = [] }

  document.addEventListener('click', event => {
    const origin = event.target instanceof Element ? event.target : null
    const target = origin?.closest('button,a,[role="button"],[role="menuitem"],[role="tab"]')
    if (target) recordOperation({ kind: 'click', target: targetName(target) })
    else if (origin?.closest('canvas,svg')) recordOperation({ kind: 'click', target: `画布点击 @ ${elementPath(origin)}` })
  }, true)
  document.addEventListener('change', event => {
    const target = event.target
    if (target instanceof HTMLInputElement || target instanceof HTMLSelectElement
      || target instanceof HTMLTextAreaElement) {
      recordOperation({ kind: 'change', target: targetName(target) })
    }
  }, true)
  document.addEventListener('input', event => {
    const target = event.target
    if (!(target instanceof Element)) return
    const editable = target.closest('[contenteditable="true"]')
    const input = target instanceof HTMLInputElement && !['password', 'file', 'hidden'].includes(target.type)
    if (!editable && !input && !(target instanceof HTMLTextAreaElement)) return
    const now = Date.now()
    if (now - (recentInputs.get(target) ?? 0) < 5_000) return
    recentInputs.set(target, now)
    recordOperation({ kind: 'input', target: editable ? `正文编辑 @ ${elementPath(target)}` : targetName(target) })
  }, true)
  document.addEventListener('submit', event => {
    if (event.target instanceof Element) recordOperation({ kind: 'submit', target: targetName(event.target) })
  }, true)
  document.addEventListener('keydown', event => {
    if (!(event.ctrlKey || event.metaKey) || !['s', 'z', 'y'].includes(event.key.toLowerCase())) return
    recordOperation({ kind: 'shortcut', target: `${event.metaKey ? 'Meta' : 'Ctrl'}+${event.key.toUpperCase()}` })
  }, true)
  document.addEventListener('drop', event => {
    if (event.target instanceof Element) recordOperation({ kind: 'drop', target: targetName(event.target) })
  }, true)
  document.addEventListener('pointerdown', event => {
    pointerStart = event.target instanceof Element ? { x: event.clientX, y: event.clientY, target: event.target } : null
  }, true)
  document.addEventListener('pointerup', event => {
    const start = pointerStart
    pointerStart = null
    if (!start || Math.hypot(event.clientX - start.x, event.clientY - start.y) < 8) return
    recordOperation({ kind: 'drag', target: targetName(start.target) })
  }, true)
}

export function resetOperationTraceForTest(): void {
  entries = []
  try { sessionStorage.removeItem(KEY) } catch { /* no-op */ }
}
