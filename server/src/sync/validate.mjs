/**
 * Push 信封校验。
 *
 * 严格程度是**故意的**：宁可拒绝一次同步，也不要把残缺数据当权威写进库。
 * 尤其第 4 条 —— 55 张同步表必须全部出现。导出引擎（`deriveExportProjectJSON`）
 * 总是逐表写键，所以缺键只可能来自客户端 bug 或被篡改的请求；
 * 若宽容处理（缺键当空数组），一次畸形推送就能把远端整表清空。
 */
import { SYNC_TABLES, SYNC_TABLE_SET } from '../generated/table-manifest.mjs'
import { HttpError } from '../http/respond.mjs'

const PROJECT_UID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const OP_ID_RE = /^[A-Za-z0-9_-]{8,64}$/
const MAX_NAME_LENGTH = 200
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

/** 协议版本。与前端 `src/lib/cloud/types.ts` 的 `protocol` 对应。 */
export const PUSH_PROTOCOL = 1

export function assertProjectUid(projectUid) {
  if (typeof projectUid !== 'string' || !PROJECT_UID_RE.test(projectUid)) {
    throw new HttpError(400, 'bad_project_uid', '项目标识格式无效')
  }
  return projectUid
}

function sanitizeRow(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return row
  for (const key of FORBIDDEN_KEYS) {
    if (Object.prototype.hasOwnProperty.call(row, key)) delete row[key]
  }
  return row
}

/**
 * 校验并归一化 push 请求体。
 *
 * @returns {{
 *   opId: string, projectUid: string, baseRev: number,
 *   exportData: object, tables: Map<string, unknown[]>, name: string, exportVersion: number
 * }}
 */
export function validatePushEnvelope(body) {
  if (!body || typeof body !== 'object') throw new HttpError(400, 'bad_body', '请求体不是对象')

  if (body.protocol !== PUSH_PROTOCOL) {
    throw new HttpError(400, 'bad_protocol', `不支持的同步协议版本：${body.protocol}`)
  }

  const opId = body.opId
  if (typeof opId !== 'string' || !OP_ID_RE.test(opId)) {
    throw new HttpError(400, 'bad_op_id', 'opId 格式无效')
  }

  const projectUid = assertProjectUid(body.projectUid)

  const baseRev = body.baseRev
  if (!Number.isInteger(baseRev) || baseRev < 0) {
    throw new HttpError(400, 'bad_base_rev', 'baseRev 必须是非负整数')
  }

  const exportData = body.export
  if (!exportData || typeof exportData !== 'object' || Array.isArray(exportData)) {
    throw new HttpError(400, 'bad_export', '缺少 export 载荷')
  }

  const project = exportData.project
  if (!project || typeof project !== 'object' || Array.isArray(project)) {
    throw new HttpError(422, 'bad_project', 'export.project 缺失或不是对象')
  }
  const name = typeof project.name === 'string' ? project.name.trim() : ''
  if (!name) throw new HttpError(422, 'bad_project_name', '项目名不能为空')
  if (name.length > MAX_NAME_LENGTH) {
    throw new HttpError(422, 'bad_project_name', `项目名超过 ${MAX_NAME_LENGTH} 字符`)
  }

  const exportVersion = Number.isInteger(exportData.version) ? exportData.version : 0
  if (exportVersion < 1 || exportVersion > 4) {
    throw new HttpError(422, 'bad_export_version', `不支持的导出格式版本：${exportData.version}`)
  }

  const tables = new Map()
  // projects 根表在导出里是对象（`export.project`），统一包装成单元素数组存储。
  tables.set('projects', [sanitizeRow({ ...project })])

  for (const tableName of SYNC_TABLES) {
    if (tableName === 'projects') continue

    if (!SYNC_TABLE_SET.has(tableName)) continue

    const rows = exportData[tableName]
    if (!Array.isArray(rows)) {
      throw new HttpError(422, 'missing_table', `缺少表或不是数组：${tableName}`)
    }
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index]
      if (!row || typeof row !== 'object' || Array.isArray(row)) {
        throw new HttpError(422, 'bad_row', `表 ${tableName} 的第 ${index} 行不是对象`)
      }
      sanitizeRow(row)
    }
    tables.set(tableName, rows)
  }

  return { opId, projectUid, baseRev, exportData, tables, name, exportVersion }
}
