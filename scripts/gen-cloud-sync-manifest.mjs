/**
 * CLOUD-DB-1 · 从 `PROJECT_TABLES` 派生服务端同步表清单。
 *
 * 为什么不直接 import 注册表：`project-tables.ts` 会 `import { db } from '../db/schema'`，
 * 把 Dexie 和整个浏览器环境拖进 Node 进程。所以这里做**单向派生**：
 * 源码 → 生成的常量 → 服务端消费。
 *
 * 一致性由 `tests/registry/R-cloud-sync-tables.test.ts` 兜住：
 * 生成物与 `PROJECT_TABLES.filter(s => s.exportable).map(s => s.name)` 必须逐项相等。
 *
 * 用法：
 *   node scripts/gen-cloud-sync-manifest.mjs            # 写入
 *   node scripts/gen-cloud-sync-manifest.mjs --check    # 只校验（CI 用）
 */
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const ROOT = process.cwd()
const REGISTRY = path.join(ROOT, 'src/lib/registry/project-tables.ts')
const OUTPUT = path.join(ROOT, 'server/src/generated/table-manifest.mjs')

/**
 * 从注册表源码里抽取 `exportable: true` 的表名，保持声明顺序。
 *
 * 按 `table: db.` 切段：每段恰好是一个 TableSpec 条目，段内不会再出现该模式，
 * 因此 `name:` 与 `exportable:` 的归属是确定的。
 */
export function extractExportableTables(source) {
  const segments = source.split(/table:\s*db\./)
  const names = []
  for (const segment of segments.slice(1)) {
    const name = segment.match(/name:\s*'([^']+)'/)?.[1]
    if (!name) continue
    if (!/exportable:\s*true/.test(segment)) continue
    names.push(name)
  }
  return names
}

export function buildManifestSource(tables) {
  return `/**
 * ⚠️ 自动生成，请勿手改。
 *
 * 来源：\`src/lib/registry/project-tables.ts\` 中 \`exportable === true\` 的条目，保持声明顺序。
 * 重新生成：\`node scripts/gen-cloud-sync-manifest.mjs\`
 * 一致性校验：\`tests/registry/R-cloud-sync-tables.test.ts\`
 *
 * 服务端只把这些表当作**不透明载荷**存进 \`project_tables.payload_json\`，
 * 因此前端给任意表加字段都不需要改服务端。
 */
export const SYNC_TABLES = Object.freeze(${JSON.stringify(tables, null, 2)})

/** 表数量（55：含 \`projects\` 根表）。 */
export const SYNC_TABLE_COUNT = SYNC_TABLES.length

/** 是否为已知同步表（拒绝客户端塞入未知表名）。 */
export const SYNC_TABLE_SET = new Set(SYNC_TABLES)
`
}

function main() {
  const source = fs.readFileSync(REGISTRY, 'utf8')
  const tables = extractExportableTables(source)
  if (tables.length === 0) throw new Error('[cloud-manifest] 未从注册表抽到任何表')
  if (!tables.includes('projects')) throw new Error('[cloud-manifest] 缺少 projects 根表')

  const generated = buildManifestSource(tables)
  const isCheck = process.argv.includes('--check')

  if (isCheck) {
    if (!fs.existsSync(OUTPUT)) {
      console.error('[cloud-manifest] 缺少生成物，请运行 node scripts/gen-cloud-sync-manifest.mjs')
      process.exitCode = 1
      return
    }
    const existing = fs.readFileSync(OUTPUT, 'utf8')
    if (existing !== generated) {
      console.error('[cloud-manifest] 生成物与注册表不一致，请重新生成后提交。')
      process.exitCode = 1
      return
    }
    console.log(`[cloud-manifest] ok: ${tables.length} 张同步表与注册表一致`)
    return
  }

  fs.mkdirSync(path.dirname(OUTPUT), { recursive: true })
  fs.writeFileSync(OUTPUT, generated, 'utf8')
  console.log(`[cloud-manifest] wrote ${path.relative(ROOT, OUTPUT)} (${tables.length} tables)`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
