/**
 * 测试脚手架：临时库 + 临时 HTTP 服务 + 极简请求器。
 */
import './setup.mjs'

import http from 'node:http'
import fs from 'node:fs'
import crypto from 'node:crypto'
import { openDatabase } from '../src/db.mjs'
import { createServer } from '../src/index.mjs'
import { hashPassword } from '../src/auth/password.mjs'
import { SYNC_TABLES } from '../src/generated/table-manifest.mjs'

export const TEST_PASSWORD = 'correct-horse-battery-staple'

/** 启动一个隔离的服务实例。 */
export async function startTestServer() {
  const db = openDatabase()
  const server = createServer(db)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  const baseUrl = `http://127.0.0.1:${port}`

  return {
    db,
    server,
    baseUrl,
    async close() {
      await new Promise((resolve) => server.close(resolve))
      try {
        db.close()
      } catch {
        // 已关闭
      }
    },
  }
}

export async function createUser(db, username = 'author', role = 'author') {
  const hash = await hashPassword(TEST_PASSWORD)
  const timestamp = Date.now()
  const result = db.prepare(
    `INSERT INTO users (username, password_hash, role, disabled, created_at, password_changed_at)
     VALUES (?, ?, ?, 0, ?, ?)`,
  ).run(username, hash, role, timestamp, timestamp)
  return Number(result.lastInsertRowid)
}

/**
 * 发起请求。
 *
 * @param {string} baseUrl
 * @param {string} method
 * @param {string} pathname
 * @param {{ body?: unknown, rawBody?: Buffer, headers?: Record<string,string>, cookie?: string }} [options]
 */
export function request(baseUrl, method, pathname, options = {}) {
  const url = new URL(pathname, baseUrl)
  const payload = options.rawBody
    ?? (options.body === undefined ? null : Buffer.from(JSON.stringify(options.body)))

  const headers = {
    origin: baseUrl,
    'x-sf-client': 'storyforge',
    ...(options.cookie ? { cookie: options.cookie } : {}),
    ...(payload ? { 'content-length': payload.length } : {}),
    ...(options.body !== undefined ? { 'content-type': 'application/json' } : {}),
    ...(options.headers ?? {}),
  }

  return new Promise((resolve, reject) => {
    const req = http.request(url, { method, headers }, (res) => {
      const chunks = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        let json = null
        try {
          json = text ? JSON.parse(text) : null
        } catch {
          json = null
        }
        resolve({ status: res.statusCode, headers: res.headers, json, text })
      })
    })
    req.on('error', reject)
    if (payload) req.write(payload)
    req.end()
  })
}

/** 登录并返回可直接塞进 `cookie` 选项的串。 */
export async function login(baseUrl, username = 'author', password = TEST_PASSWORD) {
  const response = await request(baseUrl, 'POST', '/api/auth/login', {
    body: { username, password },
  })
  const setCookie = response.headers['set-cookie']
  const raw = Array.isArray(setCookie) ? setCookie[0] : setCookie
  return { response, cookie: raw ? raw.split(';')[0] : null }
}

/** 构造一份形状完整（55 张表全在）的导出载荷。 */
export function buildExport(overrides = {}) {
  const data = {
    version: 3,
    exportedAt: Date.now(),
    project: {
      name: '测试项目',
      genre: 'fantasy',
      genres: [],
      status: 'writing',
      description: '',
      targetWordCount: 1000,
      ...(overrides.project ?? {}),
    },
  }
  for (const tableName of SYNC_TABLES) {
    if (tableName === 'projects') continue
    data[tableName] = overrides[tableName] ?? []
  }
  return data
}

export function pushEnvelope({ projectUid, baseRev, exportData, opId }) {
  return {
    protocol: 1,
    opId: opId ?? crypto.randomUUID(),
    projectUid,
    baseRev,
    clientId: 'test-client',
    export: exportData,
  }
}

export function newProjectUid() {
  return crypto.randomUUID()
}

export { SYNC_TABLES }
export { fs }
