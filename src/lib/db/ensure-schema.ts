import Dexie from 'dexie'
import { log } from '../logging/logger'
import { captureAllProjectsBeforeReset } from '../safety/rescue-vault'

export const REQUIRED_TABLES = [
  'aiUsageLog',
  'agentConversations',
  'agentEvents',
  'chapters',
  'characterRelations',
  'characterDrivenPlans',
  'characters',
  'codexCategories',
  'codexEntries',
  'creativeRules',
  'cultivationSystems',
  'cultivationProgress',
  'detailedOutlines',
  'emotionBeatCards',
  'foreshadows',
  'geographies',
  'historicalKeywords',
  'historicalTimelineEvents',
  'histories',
  'importFiles',
  'importJobs',
  'importLogs',
  'importSessions',
  'inspirationWorkspaces',
  'importantLocations',
  'itemLedger',
  'knowledgeLedger',
  'mapAssetBlobs',
  'mapAssets',
  'mapFeatures',
  'mapObservations',
  'mapRelations',
  'mapLegendEntries',
  'mapCategoryDefinitions',
  'mapScanTasks',
  'notes',
  'narrativeSummaryNodes',
  'nodeFlows',
  'nodeRuns',
  'outlineNodes',
  'powerSystems',
  'projects',
  'promptTemplates',
  'promptWorkflows',
  'referenceChunkAnalysis',
  'referenceAnalysisRuns',
  'referenceAnalysisSources',
  'references',
  'retrievalChunks',
  'snapshots',
  'simulationCheckpoints',
  'stepJournal',
  'simulationEvents',
  'simulationSessions',
  'stateCards',
  'storyArcs',
  'storyCores',
  'storylineCrossings',
  'storylineProgress',
  'storyTimelineEvents',
  'temporalFacts',
  'userStyleProfiles',
  'worldGroupLinks',
  'worldGroups',
  'worldNodes',
  'worldRulesProfiles',
  'worldviews',
] as const

export interface EnsureSchemaOptions {
  /** Explicit one-off confirmation. Never derive this from DEV or other environment flags. */
  allowDestructiveReset?: boolean
  /** Tests can disable browser alert while still asserting non-destructive behavior. */
  notifyUser?: boolean
  /**
   * 代码侧期望的 schema 版本（= Dexie 里最大的 `this.version(n)`）。
   * 用于区分"旧库等待升级"和"库比代码还新"：
   * 前者是正常升级路径，绝不能清库；后者是不兼容，仍需显式确认和库外备份。
   */
  expectedVersion?: number
}

/** 为什么判定需要重建/需要升级，供调用方与测试判读。 */
export type EnsureSchemaReason =
  | 'ok'
  | 'no-database'
  | 'pending-upgrade'
  | 'database-newer-than-code'
  | 'backup-failed'
  | 'reset'

/**
 * Schema 健康自检。
 *
 * ⚠️ 这里有一条**血泪规则**（真实事故，见 R-17b）：**缺表不等于库坏了**。
 * `ensureSchema` 用原生 `indexedDB.open(name)`（不带版本）探测，看到的是**升级前**的
 * 表清单。因此"新增了一张表"这类**纯增量升级**在探测时同样表现为"缺表"。
 * 旧实现在开发环境对这种缺表直接 `Dexie.delete('storyforge')`，于是
 * **每次单纯加表的版本升级都会在首次加载时删掉作者全部手稿**——而且发生在任何界面渲染之前，
 * 作者只看到"数据不见了"，没有任何提示。
 *
 * 现在的判定：
 *   1. 期望表全在 → 放行；
 *   2. 库版本 **低于** 代码（缺表属于尚未执行的升级）→ **绝不清库**，交给 `db.open()` 升级；
 *   3. 库版本 **高于** 代码 → 真正不兼容，默认阻止重置；
 *   4. 只有显式授权且库外导出完整时才可能重置，与 DEV 标志无关。
 */
export async function ensureSchema(
  expectedTables: readonly string[],
  options: EnsureSchemaOptions = {},
): Promise<{ reset: boolean; missing: string[]; blocked: boolean; reason: EnsureSchemaReason }> {
  const dbName = 'storyforge'
  const { allowDestructiveReset = false, notifyUser = true, expectedVersion } = options

  // 1. 检查 DB 是否存在 + 当前 schema
  const info = await probeDatabase(dbName)
  if (info === null) {
    // DB 还不存在，让 Dexie 后续按最新定义创建
    return { reset: false, missing: [], blocked: false, reason: 'no-database' }
  }

  const missing = expectedTables.filter(t => !info.stores.includes(t))
  if (missing.length === 0) {
    // 全部期望表都在
    return { reset: false, missing: [], blocked: false, reason: 'ok' }
  }

  // 2. 库比代码旧：这是**待执行的正常升级**，不是损坏。
  //    绝不删库——让 db.open() 按 Dexie 定义补齐表。
  //    注意：没有传 expectedVersion 时按"旧库"处理（fail-safe）——
  //    宁可让本次升级延后，也不能因为"证明不了库更新"就删掉作者手稿。
  const olderThanCode = expectedVersion == null || info.version < expectedVersion
  if (olderThanCode) {
    log.info(
      'schema',
      'schema.upgrade.pending',
      `[schema] 本地库 v${info.version} 缺表 [${missing.join(', ')}]，属于待执行升级，交由 Dexie 升级补齐（不删库）`,
      { dbVersion: info.version, expectedVersion: expectedVersion ?? null, missing: missing.join(',') },
    )
    return { reset: false, missing, blocked: false, reason: 'pending-upgrade' }
  }

  // 3. 库比代码新：真正不兼容（旧代码打不开新结构）。
  const newerThanCode = expectedVersion != null && info.version > expectedVersion
  if (newerThanCode && !allowDestructiveReset) {
    log.error(
      'schema',
      'schema.version.newer',
      `[schema] 本地库 v${info.version} 高于代码期望 v${expectedVersion}，已阻止自动删库，请先导出备份。`,
      { dbVersion: info.version, expectedVersion },
    )
    if (notifyUser) notifySchemaMismatch(missing)
    return { reset: false, missing, blocked: true, reason: 'database-newer-than-code' }
  }

  if (!allowDestructiveReset) {
    log.error(
      'schema',
      'schema',
      `[schema] DB v${info.version} 缺少表 [${missing.join(', ')}]。已阻止自动删库,请先导出备份后再处理。`,
    )
    if (notifyUser) notifySchemaMismatch(missing)
    return { reset: false, missing, blocked: true, reason: 'ok' }
  }

  if (!newerThanCode) {
    // 走到这里说明"缺表但版本不旧也不新"——结构异常。
    // 显式确认仍需通过完整库外导出门槛。
    log.warn(
      'schema',
      'schema.structure.abnormal',
      `[schema] DB v${info.version} 缺表 [${missing.join(', ')}] 且版本不旧于代码，显式重置请求待备份验证`,
      { dbVersion: info.version, expectedVersion, missing: missing.join(',') },
    )
  } else {
    log.warn(
      'schema',
      'schema.reset.development',
      `[schema] DB v${info.version} 高于代码期望 v${expectedVersion}，显式重置请求待备份验证`,
      { dbVersion: info.version, expectedVersion },
    )
  }

  // 4. 删库前**抢救**：把所有项目各存一份到库外哨兵库（storyforge-rescue）。
  //    这是最后一道防线——即使前面的判定逻辑本身有 bug 误判了"要删库"，
  //    用户也只是"看到数据不见了"，刷新后启动自愈会把副本自动拉回来（见 main.tsx）。
  //    注意：captureAllProjectsBeforeReset 内部用原生 indexedDB 读主库且绝不抛错，
  //    因此它不会因为主库结构异常而让"最需要备份的时刻反而备不了"。
  const counts = await countExistingRows(dbName)
  const rescued = await captureAllProjectsBeforeReset()
  if (rescued !== counts.projects || (counts.projects === 0 && counts.total > 0)) {
    log.error('schema', 'schema.reset.backup.failed',
      '[schema] 库外导出未覆盖全部项目或库中仍有未归属数据，已阻止删库',
      { rescued, projectCount: counts.projects, totalRows: counts.total })
    if (notifyUser) notifySchemaMismatch(missing)
    return { reset: false, missing, blocked: true, reason: 'backup-failed' }
  }
  if (rescued > 0) {
    log.info('schema', 'schema.reset.rescued',
      `[schema] 删库前已把 ${rescued} 个项目存入库外副本，可在启动时自动恢复`,
      { rescued })
  }

  // 5. 删库
  await Dexie.delete(dbName)
  log.info('schema', 'schema', '[schema] DB 已重置，下次打开时会按最新 schema 全新创建')
  return {
    reset: true,
    missing,
    blocked: false,
    reason: newerThanCode ? 'database-newer-than-code' : 'reset',
  }
}

/** 原生只读计数，避免异常 schema 触发 Dexie 升级。计数失败会阻止重置。 */
function countExistingRows(name: string): Promise<{ projects: number; total: number }> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name)
    request.onsuccess = () => {
      const database = request.result
      const names = [...database.objectStoreNames]
      if (!names.length) {
        database.close()
        resolve({ projects: 0, total: 0 })
        return
      }
      const tx = database.transaction(names, 'readonly')
      let total = 0
      let projects = 0
      for (const tableName of names) {
        const count = tx.objectStore(tableName).count()
        count.onsuccess = () => {
          total += count.result
          if (tableName === 'projects') projects = count.result
        }
      }
      tx.oncomplete = () => { database.close(); resolve({ projects, total }) }
      tx.onerror = () => { database.close(); reject(tx.error) }
      tx.onabort = () => { database.close(); reject(tx.error) }
    }
    request.onerror = () => reject(request.error)
    request.onblocked = () => reject(new Error('IndexedDB 读取被阻塞'))
  })
}

function notifySchemaMismatch(missing: string[]) {
  try {
    if (typeof window === 'undefined' || typeof window.alert !== 'function') return
    window.alert(
      'StoryForge 检测到本地数据库结构不完整,为保护你的小说数据,系统不会自动清空数据库。\n\n' +
      `缺失表:${missing.join(', ')}\n\n` +
      '请先导出备份,然后刷新页面或联系维护者处理。',
    )
  } catch {
    // 提示失败不能影响数据保护路径。
  }
}

/** 探测 DB：不存在返回 null，存在返回 { version, stores }。 */
function probeDatabase(name: string): Promise<{ version: number; stores: string[] } | null> {
  return new Promise((resolve, reject) => {
    let upgradeNeededFired = false
    const req = indexedDB.open(name)
    req.onsuccess = () => {
      const db = req.result
      // 如果触发了 onupgradeneeded 但版本仍是 1，说明 DB 此前不存在
      if (upgradeNeededFired) {
        const version = db.version
        const stores = [...db.objectStoreNames]
        db.close()
        // DB 是被这次 open 创建出来的，stores 必然为空 — 视为"不存在"
        if (version === 1 && stores.length === 0) {
          // 立刻清掉这个空库，让 Dexie 后面按真实 schema 创建
          indexedDB.deleteDatabase(name)
          resolve(null)
          return
        }
        resolve({ version, stores })
      } else {
        const result = { version: db.version, stores: [...db.objectStoreNames] }
        db.close()
        resolve(result)
      }
    }
    req.onerror = () => reject(req.error)
    req.onupgradeneeded = () => {
      upgradeNeededFired = true
    }
    req.onblocked = () => reject(new Error('IndexedDB 打开被阻塞，请关闭其他 storyforge tab'))
  })
}
