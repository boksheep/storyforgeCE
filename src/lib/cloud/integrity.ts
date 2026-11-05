/**
 * CLOUD-DB-1 · 导出完整性闸门 + 内容哈希
 *
 * ## 为什么需要"完整性闸门"
 *
 * `registry-export.ts` 里有 2 处 `onUnmapped: 'drop'`（`characterRelations` 的
 * `fromCharacterId` / `toCharacterId`）：**孤儿角色关系会在导出时被静默丢弃**。
 * 本地看是"这条关系指向已删除角色"，导出看是"这行不存在"。
 *
 * 单机导出时这没问题（用户能立刻发现关系少了）。但云端同步会把这份"已丢弃"的结果
 * 当成**权威**写进服务器，于是拉到新设备时这些关系永久消失。
 *
 * 所以推送前必须对账：本地行数 ≠ 导出行数时**拒绝推送**，让用户先清理，
 * 而不是把残缺数据传上去。
 *
 * ## 为什么哈希要剔除 `exportedAt`
 *
 * `deriveExportProjectJSON` 每次导出都写 `exportedAt: Date.now()`。
 * 不剔除它，"内容没变就跳过"永远不命中，会退化成每 45 秒全量上传。
 * 服务端 `server/src/sync/content-hash.mjs` 用**完全相同**的规则。
 */
import { PROJECT_TABLES } from '../registry/project-tables'

/** 递归排序对象键，保证序列化与插入顺序无关。 */
function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep)
  if (value && typeof value === 'object') {
    const source = value as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(source).sort()) out[key] = sortDeep(source[key])
    return out
  }
  return value
}

/** 确定性 JSON 序列化（键有序）。 */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortDeep(value))
}

function toHex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

/** 内容哈希：剔除顶层 `exportedAt` 后做规范化 sha256。 */
export async function contentSha256(exportData: Record<string, unknown>): Promise<string> {
  const { exportedAt, ...rest } = exportData
  void exportedAt
  const bytes = new TextEncoder().encode(stableStringify(rest))
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return toHex(digest)
}

export interface IntegrityIssue {
  table: string
  localRows: number
  exportedRows: number
  reason: string
}

/**
 * 校验"导出结果是否忠实反映本地数据"。
 *
 * 只检查声明了 `onUnmapped: 'drop'` 的表 —— 那是唯一会**主动丢弃行**的路径。
 * 其他表的导出是逐行 1:1 映射，不需要额外对账。
 */
export async function checkExportIntegrity(
  projectId: number,
  exportData: Record<string, unknown>,
): Promise<IntegrityIssue[]> {
  const issues: IntegrityIssue[] = []

  const dropSpecs = PROJECT_TABLES.filter(spec =>
    spec.exportable
    && spec.owner === 'project'
    && (spec.exportRemap ?? []).some(remap => remap.onUnmapped === 'drop'),
  )

  for (const spec of dropSpecs) {
    const exported = exportData[spec.name]
    if (!Array.isArray(exported)) continue

    // 这里读库是安全的：调用点在推送流程里，不在 Dexie 事务中。
    const localRows = await spec.table.where('projectId').equals(projectId).count()
    if (localRows !== exported.length) {
      issues.push({
        table: spec.name,
        localRows,
        exportedRows: exported.length,
        reason: `有 ${localRows - exported.length} 行指向已删除的实体，导出时会被丢弃`,
      })
    }
  }

  return issues
}

/** 把完整性问题的说明拼成一句可读中文（用于 UI 与日志）。 */
export function describeIntegrityIssues(issues: IntegrityIssue[]): string {
  return issues
    .map(issue => `${issue.table}：本地 ${issue.localRows} 行，导出 ${issue.exportedRows} 行（${issue.reason}）`)
    .join('；')
}
