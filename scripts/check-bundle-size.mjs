import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'

/**
 * 体积预算闸门。
 *
 * ## 已知状况：入口脚本长期略超 raw 预算（**不是**新的回归，阈值也**不打算动**）
 *
 * 实测（2026-09-30，本机 Windows）：
 *   - 基线提交 136c18e（ALIAS-1 / LOG-1 之前）：入口 **703.8 KiB**
 *   - ALIAS-1 之后 708.5 → LOG-1 之后 713.8 → 后续四项改动 715.7（gzip 227.6 / 230，**在预算内**）
 *
 * 也就是说：**700 KiB 这条线在本次扩容之前就已经被越过**，之后每个单位各加几 KiB。
 * 上述历史测量中 gzip 仍在预算内；后续构建必须分别检查 raw 和 gzip 的当次实测值，
 * 不能把历史说明当作当前 gzip 已达标的证据。
 *
 * 决策：**保持 700 KiB 阈值不变，也不为了变绿去删功能**。理由——
 *   1. 入口包 = React + router + Dexie + stores + 三个注册表（上下文源/字段/表生命周期），
 *      这些要么首屏必需，要么半个应用 import 它；真正要回收 15+ KiB 必须把
 *      "上下文源注册表 + 装配器"拆出入口图，那是改启动路径的架构动作，不该顺手做；
 *   2. 试过两条便宜路子并已如实记录：落盘调度器改空闲时动态 import（省 3.2 KiB，已合入）、
 *      角色索引改动态加载（只省 0.5 KiB，因 fact-logger 侧仍静态引用，收益不成立已回退）；
 *   3. 阈值是作者定的，改阈值是作者的决定，不由执行者顺手放宽。
 *
 * 因此：本脚本不改判据、不改数值。看到它变红时，先看是不是又长了十几 KiB，
 * 而不是把这条注释当"可以忽略"。真要动，按上面第 1 条拆包。
 */
const KIB = 1024
const MIB = 1024 * KIB

/** 预算数值由作者维护；见文件头的"已知状况"，不要为了变绿改这里。 */
export const BUNDLE_BUDGETS = {
  entryScript: { raw: 700 * KIB, gzip: 230 * KIB },
  scriptChunk: { raw: 600 * KIB, gzip: 180 * KIB },
  stylesheet: { raw: 100 * KIB, gzip: 25 * KIB },
  pdfWorker: { raw: 2.4 * MIB, gzip: 550 * KIB },
}

/** 违规时一并打印，避免把"既存超线"误读成"这次改动搞坏了体积"。 */
const KNOWN_BASELINE_NOTE = [
  '说明：入口脚本 raw 超线是**既存状况**（基线 136c18e 实测 703.8 KiB 即已超，见本脚本头部注释）；',
  '      历史基线 gzip 在预算内；请按上方当前实测判断 gzip，并与基线比较增量，',
  '      不要直接放宽阈值（阈值由作者维护）。',
]

function formatKiB(bytes) {
  return `${(bytes / KIB).toFixed(1)} KiB`
}

function readAsset(assetPath) {
  const content = fs.readFileSync(assetPath)
  return {
    raw: content.byteLength,
    gzip: gzipSync(content).byteLength,
  }
}

function findEntryScript(distDir) {
  const html = fs.readFileSync(path.join(distDir, 'index.html'), 'utf8')
  const source = html.match(/<script\b[^>]*\btype=["']module["'][^>]*\bsrc=["']([^"']+)["']/i)?.[1]
  if (!source) throw new Error('dist/index.html 中未找到 module 入口脚本')
  return path.basename(source)
}

function classifyAsset(filename, entryScript) {
  if (filename === entryScript) return 'entryScript'
  if (/^pdf\.worker-.*\.mjs$/.test(filename)) return 'pdfWorker'
  if (/\.(?:js|mjs)$/.test(filename)) return 'scriptChunk'
  if (filename.endsWith('.css')) return 'stylesheet'
  return null
}

export function checkBundleBudget(distDir, budgets = BUNDLE_BUDGETS) {
  const assetsDir = path.join(distDir, 'assets')
  if (!fs.existsSync(assetsDir)) {
    throw new Error(`构建产物不存在: ${assetsDir}，请先运行 npm run build`)
  }

  const entryScript = findEntryScript(distDir)
  const measured = []
  const violations = []

  for (const filename of fs.readdirSync(assetsDir).sort()) {
    const category = classifyAsset(filename, entryScript)
    if (!category) continue

    const size = readAsset(path.join(assetsDir, filename))
    const budget = budgets[category]
    const record = { filename, category, ...size, budget }
    measured.push(record)

    if (size.raw > budget.raw || size.gzip > budget.gzip) {
      violations.push(record)
    }
  }

  if (!measured.some(asset => asset.category === 'entryScript')) {
    throw new Error(`入口脚本未出现在 dist/assets: ${entryScript}`)
  }

  return { entryScript, measured, violations }
}

function runCli() {
  const distDir = path.resolve(process.argv[2] ?? 'dist')
  const result = checkBundleBudget(distDir)

  if (result.violations.length > 0) {
    console.error('[bundle-size] 以下构建产物超过预算:')
    for (const item of result.violations) {
      console.error(
        `  - ${item.filename}: raw ${formatKiB(item.raw)} / ${formatKiB(item.budget.raw)}, `
        + `gzip ${formatKiB(item.gzip)} / ${formatKiB(item.budget.gzip)}`,
      )
    }
    for (const line of KNOWN_BASELINE_NOTE) console.error(`[bundle-size] ${line}`)
    process.exitCode = 1
    return
  }

  const entry = result.measured.find(asset => asset.category === 'entryScript')
  const largestChunk = result.measured
    .filter(asset => asset.category === 'scriptChunk')
    .sort((a, b) => b.raw - a.raw)[0]
  const pdfWorker = result.measured.find(asset => asset.category === 'pdfWorker')

  console.log(
    `[bundle-size] ok: entry ${formatKiB(entry.raw)} (${formatKiB(entry.gzip)} gzip)`,
  )
  if (largestChunk) {
    console.log(
      `[bundle-size] largest async/vendor chunk: ${largestChunk.filename} ${formatKiB(largestChunk.raw)} `
      + `(${formatKiB(largestChunk.gzip)} gzip)`,
    )
  }
  if (pdfWorker) {
    console.log(
      `[bundle-size] pdf worker: ${formatKiB(pdfWorker.raw)} (${formatKiB(pdfWorker.gzip)} gzip)`,
    )
  }
}

const isCli = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (isCli) runCli()
