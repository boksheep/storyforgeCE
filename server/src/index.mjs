/**
 * StoryForge 云数据库服务 · HTTP 入口。
 *
 * 技术选型：**零运行时依赖** —— `node:http` + `node:sqlite` + `node:crypto`。
 * 因此部署时不需要 `npm install`，没有 native 编译，容器镜像里只有 Node 与源码。
 *
 * 路由全部挂在 `/api` 下（前端 `apiBase` 默认就是 `/api`，由 nginx 同源反代）。
 */
import http from 'node:http'
import { pathToFileURL } from 'node:url'
import { env, requestProtocol } from './env.mjs'
import { openDatabase } from './db.mjs'
import { log } from './log.mjs'
import { HttpError, sendError, sendJson } from './http/respond.mjs'
import { handleCaptcha, handleLogin, handleLogout, handleMe } from './auth/routes.mjs'
import { pruneExpiredSessions } from './auth/session.mjs'
import { handleForce, handlePush } from './sync/push.mjs'
import { handlePull } from './sync/pull.mjs'
import {
  handleDeleteSnapshot,
  handleGetSnapshot,
  handleListSnapshots,
  handleUploadSnapshot,
} from './sync/snapshots.mjs'
import {
  handleDeleteProject,
  handleListProjects,
  handleListVersions,
  handleStatus,
} from './sync/status.mjs'
import { PUSH_PROTOCOL } from './sync/validate.mjs'
import { SYNC_TABLE_COUNT } from './generated/table-manifest.mjs'

const PROJECT_UID_PATH = '([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})'

function handleConfig(db, req, res) {
  sendJson(res, 200, {
    app: 'storyforge',
    cloud: true,
    protocol: PUSH_PROTOCOL,
    exportVersion: 4,
    syncTableCount: SYNC_TABLE_COUNT,
    maxPushBytes: env.maxPushBytes,
  })
}

function handleHealth(db, req, res) {
  try {
    db.prepare('SELECT 1 AS ok').get()
    sendJson(res, 200, { ok: true, db: 'ok', uptimeSec: Math.round(process.uptime()) })
  } catch (error) {
    log.error('health.db_failed', { message: String(error?.message ?? error) })
    sendJson(res, 503, { ok: false, db: 'error', uptimeSec: Math.round(process.uptime()) })
  }
}

const routes = [
  { method: 'GET', pattern: /^\/api\/config$/, handler: handleConfig },
  { method: 'GET', pattern: /^\/api\/health$/, handler: handleHealth },

  { method: 'POST', pattern: /^\/api\/auth\/login$/, handler: (db, req, res) => handleLogin(db, req, res) },
  { method: 'GET', pattern: /^\/api\/auth\/captcha$/, handler: (db, req, res) => handleCaptcha(db, req, res) },
  { method: 'POST', pattern: /^\/api\/auth\/logout$/, handler: (db, req, res) => handleLogout(db, req, res) },
  { method: 'GET', pattern: /^\/api\/auth\/me$/, handler: (db, req, res) => handleMe(db, req, res) },

  { method: 'GET', pattern: /^\/api\/projects$/, handler: handleListProjects },
  {
    method: 'DELETE',
    pattern: new RegExp(`^/api/projects/${PROJECT_UID_PATH}$`),
    handler: (db, req, res, match) => handleDeleteProject(db, req, res, match[1]),
  },

  { method: 'GET', pattern: /^\/api\/sync\/status$/, handler: handleStatus },
  { method: 'GET', pattern: /^\/api\/sync\/versions$/, handler: (db, req, res, _m, url) => handleListVersions(db, req, res, url) },
  { method: 'GET', pattern: /^\/api\/sync\/pull$/, handler: (db, req, res, _m, url) => handlePull(db, req, res, url) },
  { method: 'POST', pattern: /^\/api\/sync\/push$/, handler: (db, req, res) => handlePush(db, req, res) },
  { method: 'POST', pattern: /^\/api\/sync\/force$/, handler: (db, req, res) => handleForce(db, req, res) },

  // ── 版本快照（独立于项目同步：按需上传/拉取）──
  { method: 'GET', pattern: /^\/api\/snapshots$/, handler: (db, req, res, _m, url) => handleListSnapshots(db, req, res, url) },
  { method: 'POST', pattern: /^\/api\/snapshots$/, handler: (db, req, res) => handleUploadSnapshot(db, req, res) },
  { method: 'GET', pattern: /^\/api\/snapshots\/([A-Za-z0-9_-]{8,64})$/, handler: (db, req, res, match) => handleGetSnapshot(db, req, res, match[1]) },
  { method: 'DELETE', pattern: /^\/api\/snapshots\/([A-Za-z0-9_-]{8,64})$/, handler: (db, req, res, match) => handleDeleteSnapshot(db, req, res, match[1]) },
]

async function handleRequest(db, req, res) {
  let pathname = '/'
  try {
    const url = new URL(req.url ?? '/', `${requestProtocol(req)}://${req.headers.host ?? 'localhost'}`)
    pathname = url.pathname.replace(/\/+$/, '') || '/'

    if (!pathname.startsWith('/api')) {
      throw new HttpError(404, 'not_found', '该服务只提供 /api 接口；静态资源由 nginx 提供')
    }

    for (const route of routes) {
      if (route.method !== req.method) continue
      const match = route.pattern.exec(pathname)
      if (!match) continue
      await route.handler(db, req, res, match, url)
      return
    }

    throw new HttpError(404, 'not_found', '未找到该接口')
  } catch (error) {
    if (!(error instanceof HttpError)) {
      log.error('http.unhandled', { path: pathname, message: String(error?.message ?? error) })
    }
    if (!res.headersSent) sendError(res, error)
    else res.destroy()
  }
}

/** 创建 HTTP 服务（测试直接调用，不监听端口）。 */
export function createServer(db) {
  return http.createServer((req, res) => {
    void handleRequest(db, req, res)
  })
}

/** 周期性维护：清过期会话、清 30 天前的幂等日志。 */
function startMaintenance(db) {
  const run = () => {
    try {
      const sessions = pruneExpiredSessions(db)
      const logs = db.prepare('DELETE FROM sync_log WHERE applied_at < ?').run(Date.now() - 30 * 86_400_000)
      if (sessions || Number(logs.changes) > 0) {
        log.info('maintenance.pruned', { sessions, syncLogs: Number(logs.changes) })
      }
    } catch (error) {
      log.error('maintenance.failed', { message: String(error?.message ?? error) })
    }
  }
  run()
  const timer = setInterval(run, 60 * 60_000)
  timer.unref()
  return timer
}

export function startServer() {
  const db = openDatabase()
  const server = createServer(db)
  startMaintenance(db)

  server.listen(env.port, env.host, () => {
    log.info('server.listening', {
      host: env.host,
      port: env.port,
      dbFile: env.dbFile,
      versionsDir: env.versionsDir,
      maxPushBytes: env.maxPushBytes,
      allowInsecure: env.allowInsecure,
    })
  })

  const shutdown = (signal) => {
    log.info('server.shutdown', { signal })
    server.close(() => {
      try {
        db.close()
      } catch {
        // 已关闭
      }
      process.exit(0)
    })
    // 兜底：5 秒内没关干净就强退
    setTimeout(() => process.exit(0), 5_000).unref()
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))

  return { server, db }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startServer()
}
