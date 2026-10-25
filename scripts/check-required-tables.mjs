import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const schemaPath = path.join(root, 'src/lib/db/schema.ts')
const ensureSchemaPath = path.join(root, 'src/lib/db/ensure-schema.ts')

const schemaSource = fs.readFileSync(schemaPath, 'utf8')
const ensureSchemaSource = fs.readFileSync(ensureSchemaPath, 'utf8')

const schemaTables = extractSchemaTables(schemaSource)
const requiredTables = extractRequiredTables(ensureSchemaSource)
const maxSchemaVersion = extractMaxVersion(schemaSource)

const missing = schemaTables.filter(name => !requiredTables.includes(name))
const extra = requiredTables.filter(name => !schemaTables.includes(name))

if (missing.length > 0 || extra.length > 0) {
  console.error('[required-tables] REQUIRED_TABLES does not match schema.ts')
  if (missing.length > 0) console.error(`Missing: ${missing.join(', ')}`)
  if (extra.length > 0) console.error(`Extra: ${extra.join(', ')}`)
  process.exit(1)
}

console.log(`[required-tables] ok: ${requiredTables.length} tables match schema.ts`)

// ── SCHEMA_VERSION 必须等于 schema.ts 里最大的 this.version(n) ──
// 它是启动自检判定"旧库待升级"还是"库比代码新（不兼容）"的唯一依据。
// 一旦漂移：真实事故是开发环境把"待升级"误判成"损坏"，直接删掉作者全部手稿（见 R-17b）。
const declaredVersion = extractSchemaVersion(schemaSource)
if (declaredVersion == null) {
  console.error('[required-tables] schema.ts 未导出 SCHEMA_VERSION')
  process.exit(1)
}
if (declaredVersion !== maxSchemaVersion) {
  console.error(
    `[required-tables] SCHEMA_VERSION=${declaredVersion} 与 schema.ts 最大版本 ${maxSchemaVersion} 不一致；`
    + '这会让启动自检误判库状态（可能清空作者数据）。请同步 src/lib/db/schema.ts 的 SCHEMA_VERSION。',
  )
  process.exit(1)
}
console.log(`[required-tables] ok: SCHEMA_VERSION=${declaredVersion} 与最大版本一致`)

function extractSchemaVersion(source) {
  const match = source.match(/export const SCHEMA_VERSION\s*=\s*(\d+)/)
  return match ? Number(match[1]) : null
}

function extractSchemaTables(source) {
  const names = new Set()
  const dropped = new Set()
  const storeBlockRe = /this\.version\(\d+\)\.stores\(\{([\s\S]*?)\n\s*\}\)/g
  let block
  while ((block = storeBlockRe.exec(source))) {
    // 建表(带索引字符串)
    const tableRe = /\n\s*([A-Za-z]\w*)\s*:\s*'[^']*'/g
    let table
    while ((table = tableRe.exec(block[1]))) {
      names.add(table[1])
    }
    // 删表(置 null):后续版本把某表设为 null = 删除该表
    const dropRe = /\n\s*([A-Za-z]\w*)\s*:\s*null/g
    let drop
    while ((drop = dropRe.exec(block[1]))) {
      dropped.add(drop[1])
    }
  }
  for (const name of dropped) names.delete(name)
  return [...names].sort()
}

/** schema.ts 里最大的 this.version(n)。 */
function extractMaxVersion(source) {
  let max = 0
  const re = /this\.version\((\d+)\)/g
  let match
  while ((match = re.exec(source))) {
    max = Math.max(max, Number(match[1]))
  }
  return max
}

function extractRequiredTables(source) {
  const match = source.match(/export const REQUIRED_TABLES = \[([\s\S]*?)\] as const/)
  if (!match) {
    console.error('[required-tables] REQUIRED_TABLES not found')
    process.exit(1)
  }
  const names = []
  const entryRe = /'([^']+)'/g
  let entry
  while ((entry = entryRe.exec(match[1]))) {
    names.push(entry[1])
  }
  return names.sort()
}
