/**
 * 传输与载荷安全。
 *
 * 重点是 **gzip 炸弹**：1 KiB 压缩流可以膨胀到 GB 级，若用 `gunzipSync` 整体解压，
 * 一个未登录以外的请求就能把服务端内存打满。这里锁死"流式解压 + 累计上限 + 立即中止"。
 */
import { test, before, after, describe } from 'node:test'
import assert from 'node:assert/strict'
import zlib from 'node:zlib'
import crypto from 'node:crypto'
import {
  startTestServer,
  createUser,
  login,
  request,
  buildExport,
  pushEnvelope,
  newProjectUid,
} from './helpers.mjs'
import { env } from '../src/env.mjs'

let ctx
let cookie

before(async () => {
  ctx = await startTestServer()
  await createUser(ctx.db, 'owner')
  cookie = (await login(ctx.baseUrl, 'owner')).cookie
})

after(async () => {
  await ctx.close()
})

describe('请求体上限', () => {
  test('gzip 炸弹 → 413，且不推进 rev、不落库', async () => {
    const projectUid = newProjectUid()
    const normal = await request(ctx.baseUrl, 'POST', '/api/sync/push', {
      cookie,
      body: pushEnvelope({ projectUid, baseRev: 0, exportData: buildExport() }),
    })
    assert.equal(normal.status, 201)
    const revBefore = normal.json.rev

    // 4 MiB 的 'a' 压缩后只有几 KB —— 正是炸弹的形状
    const bomb = zlib.gzipSync(Buffer.alloc(4 * 1024 * 1024, 0x61))
    assert.ok(bomb.length < env.maxCompressedBytes, '压缩后体积必须在压缩上限之内，才能测到解压上限')

    const response = await request(ctx.baseUrl, 'POST', '/api/sync/push', {
      cookie,
      rawBody: bomb,
      headers: { 'content-encoding': 'gzip', 'content-type': 'application/json' },
    })

    assert.equal(response.status, 413)
    assert.equal(response.json.error.code, 'too_large')

    const project = ctx.db.prepare('SELECT rev FROM projects WHERE project_uid = ?').get(projectUid)
    assert.equal(project.rev, revBefore, '超限请求不得改动 rev')
  })

  test('正常的 gzip 请求体可以推送成功（炸弹防护不能误伤）', async () => {
    const projectUid = newProjectUid()
    const payload = Buffer.from(JSON.stringify(
      pushEnvelope({ projectUid, baseRev: 0, exportData: buildExport({ project: { name: '压缩正常' } }) }),
    ))
    const gzipped = zlib.gzipSync(payload)

    const response = await request(ctx.baseUrl, 'POST', '/api/sync/push', {
      cookie,
      rawBody: gzipped,
      headers: { 'content-encoding': 'gzip', 'content-type': 'application/json' },
    })
    assert.equal(response.status, 201)

    const pulled = await request(ctx.baseUrl, 'GET', `/api/sync/pull?uid=${projectUid}`, { cookie })
    assert.equal(pulled.json.export.project.name, '压缩正常')
  })

  test('声明超大 Content-Length → 413（第一道闸，不解压就拒绝）', async () => {
    // 真实发送一个超过压缩上限的请求体：这样 content-length 与字节数一致，
    // 服务端在"读之前"就按声明拒绝，不会留下半读的连接。
    const oversized = Buffer.alloc(env.maxCompressedBytes + 1024, 0x61)
    const response = await request(ctx.baseUrl, 'POST', '/api/sync/push', {
      cookie,
      rawBody: oversized,
      headers: { 'content-type': 'application/json' },
    })
    assert.equal(response.status, 413)
    assert.equal(response.json.error.code, 'too_large')
  })

  test('非 JSON 请求体 → 400', async () => {
    const response = await request(ctx.baseUrl, 'POST', '/api/sync/push', {
      cookie,
      rawBody: Buffer.from('this is not json'),
      headers: { 'content-type': 'application/json' },
    })
    assert.equal(response.status, 400)
    assert.equal(response.json.error.code, 'bad_json')
  })
})

describe('信封校验', () => {
  test('协议版本不符 → 400', async () => {
    const response = await request(ctx.baseUrl, 'POST', '/api/sync/push', {
      cookie,
      body: { protocol: 99, opId: crypto.randomUUID(), projectUid: newProjectUid(), baseRev: 0, export: buildExport() },
    })
    assert.equal(response.status, 400)
    assert.equal(response.json.error.code, 'bad_protocol')
  })

  test('projectUid 不是 UUID → 400（阻断路径穿越类输入）', async () => {
    const response = await request(ctx.baseUrl, 'POST', '/api/sync/push', {
      cookie,
      body: {
        protocol: 1,
        opId: crypto.randomUUID(),
        projectUid: '../../etc/passwd',
        baseRev: 0,
        export: buildExport(),
      },
    })
    assert.equal(response.status, 400)
    assert.equal(response.json.error.code, 'bad_project_uid')
  })

  test('导出格式版本超出支持范围 → 422', async () => {
    const exportData = buildExport()
    exportData.version = 99
    const response = await request(ctx.baseUrl, 'POST', '/api/sync/push', {
      cookie,
      body: pushEnvelope({ projectUid: newProjectUid(), baseRev: 0, exportData }),
    })
    assert.equal(response.status, 422)
    assert.equal(response.json.error.code, 'bad_export_version')
  })

  test('行不是对象 → 422', async () => {
    const exportData = buildExport()
    exportData.chapters = ['字符串不是行对象']
    const response = await request(ctx.baseUrl, 'POST', '/api/sync/push', {
      cookie,
      body: pushEnvelope({ projectUid: newProjectUid(), baseRev: 0, exportData }),
    })
    assert.equal(response.status, 422)
    assert.equal(response.json.error.code, 'bad_row')
  })

  test('opId 跨项目复用 → 409', async () => {
    const opId = crypto.randomUUID()
    const first = newProjectUid()
    const second = newProjectUid()

    const ok = await request(ctx.baseUrl, 'POST', '/api/sync/push', {
      cookie,
      body: pushEnvelope({ projectUid: first, baseRev: 0, exportData: buildExport(), opId }),
    })
    assert.equal(ok.status, 201)

    const reused = await request(ctx.baseUrl, 'POST', '/api/sync/push', {
      cookie,
      body: pushEnvelope({ projectUid: second, baseRev: 0, exportData: buildExport(), opId }),
    })
    assert.equal(reused.status, 409)
    assert.equal(reused.json.error.code, 'op_id_reused')
  })
})

describe('历史版本', () => {
  test('请求不存在的版本 → 404', async () => {
    const projectUid = newProjectUid()
    await request(ctx.baseUrl, 'POST', '/api/sync/push', {
      cookie,
      body: pushEnvelope({ projectUid, baseRev: 0, exportData: buildExport() }),
    })

    const response = await request(
      ctx.baseUrl, 'GET', `/api/sync/pull?uid=${projectUid}&rev=99`, { cookie },
    )
    assert.equal(response.status, 404)
    assert.equal(response.json.error.code, 'version_not_found')
  })

  test('版本列表越权 → 404', async () => {
    await createUser(ctx.db, 'outsider')
    const outsiderCookie = (await login(ctx.baseUrl, 'outsider')).cookie
    const projectUid = newProjectUid()
    await request(ctx.baseUrl, 'POST', '/api/sync/push', {
      cookie,
      body: pushEnvelope({ projectUid, baseRev: 0, exportData: buildExport() }),
    })

    const response = await request(
      ctx.baseUrl, 'GET', `/api/sync/versions?uid=${projectUid}`, { cookie: outsiderCookie },
    )
    assert.equal(response.status, 404)
  })
})
