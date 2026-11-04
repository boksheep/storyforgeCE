/**
 * 内容哈希：**规范化后**再算 sha256。
 *
 * 为什么必须剔除 `exportedAt`：`deriveExportProjectJSON` 每次导出都写
 * `exportedAt: Date.now()`（`registry-export.ts:138`）。若把它算进哈希，
 * 同一份数据每次导出的哈希都不同 —— "sha256 相同则跳过"永不命中，
 * 退化成每 45 秒全量上传一次。
 *
 * 前后端必须使用**完全一致**的规范化规则：
 *   1. 剔除顶层 `exportedAt`
 *   2. 对象键递归排序（`stableStringify`）
 *   3. UTF-8 编码后 sha256，输出小写十六进制
 *
 * 前端对应实现：`src/lib/cloud/integrity.ts`（阶段 2 落地）。
 */
import crypto from 'node:crypto'

/** 递归排序对象键，保证序列化结果与键插入顺序无关。 */
function sortDeep(value) {
  if (Array.isArray(value)) return value.map(sortDeep)
  if (value && typeof value === 'object') {
    const out = {}
    for (const key of Object.keys(value).sort()) out[key] = sortDeep(value[key])
    return out
  }
  return value
}

/** 确定性 JSON 序列化（键有序）。 */
export function stableStringify(value) {
  return JSON.stringify(sortDeep(value))
}

export function sha256Hex(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex')
}

/** 单表哈希：对整表 JSON 数组做规范化哈希。 */
export function tableSha256(rows) {
  return sha256Hex(stableStringify(rows))
}

/** 整项目内容哈希：剔除易变的 `exportedAt`。 */
export function contentSha256(exportData) {
  const { exportedAt, ...rest } = exportData ?? {}
  void exportedAt
  return sha256Hex(stableStringify(rest))
}
