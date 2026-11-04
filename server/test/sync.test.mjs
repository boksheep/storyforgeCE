/**
 * 同步主流程：创建 / 幂等 / 并发 / 拉取 / 版本 / 删除。
 *
 * 这些用例直接对应方案 §5.4 的契约，任何一条失败都意味着客户端会丢数据或误判冲突。
 */
import { test, before, after, describe } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import {
  startTestServer,
  createUser,
  login,
  request,
  buildExport,
  pushEnvelope,
  newProjectUid,
  SYNC_TABLES,
} from './helpers.mjs'
import { contentSha256 } from '../src/sync/content-hash.mjs'

let ctx
let cookie
let otherCookie

before(async () => {
  ctx = await startTestServer()
  await createUser(ctx.db, 'owner')
  await createUser(ctx.db, 'intruder')
  cookie = (await login(ctx.baseUrl, 'owner')).cookie
  otherCookie = (await login(ctx.baseUrl, 'intruder')).cookie
})

after(async () => {
  await ctx.close()
})

function push(projectUid, baseRev, exportData, extra = {}) {
  return request(ctx.baseUrl, 'POST', '/api/sync/push', {
    cookie: extra.cookie ?? cookie,
    body: pushEnvelope({ projectUid, baseRev, exportData, opId: extra.opId }),
  })
}

describe('push', () => {
  test('首次推送创建项目 → 201，rev=1，55 张表全部落库', async () => {
    const projectUid = newProjectUid()
    const exportData = buildExport({ project: { name: '第一部' } })

    const response = await push(projectUid, 0, exportData)
    assert.equal(response.status, 201)
    assert.equal(response.json.rev, 1)
    assert.equal(response.json.created, true)
    assert.equal(response.json.changedTables.length, SYNC_TABLES.length)

    const stored = ctx.db.prepare(
      'SELECT COUNT(*) AS count FROM project_tables WHERE project_uid = ?',
    ).get(projectUid)
    assert.equal(Number(stored.count), SYNC_TABLES.length)
  })

  test('内容未变再推一次 → 200 unchanged，不推进 rev', async () => {
    const projectUid = newProjectUid()
    const exportData = buildExport()
    await push(projectUid, 0, exportData)

    const again = await push(projectUid, 1, exportData)
    assert.equal(again.status, 200)
    assert.equal(again.json.unchanged, true)
    assert.equal(again.json.rev, 1)
    assert.deepEqual(again.json.changedTables, [])
  })

  test('改了章节表 → rev+1，changedTables 只含变化的表', async () => {
    const projectUid = newProjectUid()
    const exportData = buildExport()
    await push(projectUid, 0, exportData)

    const changed = buildExport({
      chapters: [{ title: '第一章', content: '<p>正文</p>', order: 0 }],
    })
    const response = await push(projectUid, 1, changed)
    assert.equal(response.status, 200)
    assert.equal(response.json.rev, 2)
    assert.deepEqual(response.json.changedTables, ['chapters'])
  })

  test('同一 opId 重放 → 200 idempotent，rev 不变（响应丢失后的重试路径）', async () => {
    const projectUid = newProjectUid()
    const opId = crypto.randomUUID()
    const exportData = buildExport()

    const first = await push(projectUid, 0, exportData, { opId })
    assert.equal(first.status, 201)

    const replay = await push(projectUid, 0, exportData, { opId })
    assert.equal(replay.status, 200)
    assert.equal(replay.json.idempotent, true)
    assert.equal(replay.json.rev, first.json.rev)

    const versions = ctx.db.prepare(
      'SELECT COUNT(*) AS count FROM project_versions WHERE project_uid = ? AND reason = ?',
    ).get(projectUid, 'push')
    assert.equal(Number(versions.count), 1, '重放不应产生第二个版本')
  })

  test('baseRev 过期 → 409 且带远端摘要（客户端据此决策）', async () => {
    const projectUid = newProjectUid()
    await push(projectUid, 0, buildExport({ project: { name: '冲突测试' } }))
    await push(projectUid, 1, buildExport({ project: { name: '冲突测试' }, chapters: [{ title: 'A' }] }))

    const stale = await push(projectUid, 1, buildExport({ chapters: [{ title: 'B' }] }))
    assert.equal(stale.status, 409)
    assert.equal(stale.json.error.code, 'conflict')
    assert.equal(stale.json.remote.rev, 2)
    assert.ok(stale.json.remote.contentSha256)
    assert.equal(stale.json.remote.name, '冲突测试')
    // 摘要里绝不能出现载荷
    assert.equal(stale.json.remote.export, undefined)
  })

  test('缺表 → 422（防止一次畸形推送把远端整表清空）', async () => {
    const projectUid = newProjectUid()
    const broken = buildExport()
    delete broken.chapters

    const response = await push(projectUid, 0, broken)
    assert.equal(response.status, 422)
    assert.equal(response.json.error.code, 'missing_table')
  })

  test('未登录 → 401', async () => {
    const response = await request(ctx.baseUrl, 'POST', '/api/sync/push', {
      body: pushEnvelope({ projectUid: newProjectUid(), baseRev: 0, exportData: buildExport() }),
    })
    assert.equal(response.status, 401)
  })
})

describe('pull', () => {
  test('往返一致：拉回的 export 与推上去的逐字段相等（忽略 exportedAt）', async () => {
    const projectUid = newProjectUid()
    const exportData = buildExport({
      project: { name: '往返验证' },
      chapters: [
        { title: '第一章', content: '<p>甲</p>', order: 0 },
        { title: '第二章', content: '<p>乙</p>', order: 1 },
      ],
      characters: [{ name: '主角', role: 'protagonist' }],
    })
    await push(projectUid, 0, exportData)

    const pulled = await request(ctx.baseUrl, 'GET', `/api/sync/pull?uid=${projectUid}`, { cookie })
    assert.equal(pulled.status, 200)
    assert.equal(pulled.json.rev, 1)

    const expected = { ...exportData }
    delete expected.exportedAt
    const actual = { ...pulled.json.export }
    delete actual.exportedAt
    assert.deepEqual(actual, expected)

    // 服务端算的内容哈希与客户端同规则
    assert.equal(pulled.json.contentSha256, contentSha256(exportData))
  })

  test('sinceRev 等于当前 rev → 304（省一次大传输）', async () => {
    const projectUid = newProjectUid()
    await push(projectUid, 0, buildExport())

    const response = await request(
      ctx.baseUrl, 'GET', `/api/sync/pull?uid=${projectUid}&sinceRev=1`, { cookie },
    )
    assert.equal(response.status, 304)
  })

  test('越权访问他人项目 → 404（不是 403，避免泄露存在性）', async () => {
    const projectUid = newProjectUid()
    await push(projectUid, 0, buildExport())

    const response = await request(
      ctx.baseUrl, 'GET', `/api/sync/pull?uid=${projectUid}`, { cookie: otherCookie },
    )
    assert.equal(response.status, 404)

    const pushAttempt = await push(projectUid, 1, buildExport(), { cookie: otherCookie })
    assert.equal(pushAttempt.status, 404)
  })

  test('非法 projectUid → 400', async () => {
    const response = await request(ctx.baseUrl, 'GET', '/api/sync/pull?uid=../../etc/passwd', { cookie })
    assert.equal(response.status, 400)
  })
})

describe('status 与版本', () => {
  test('status 只返回元数据，不含载荷', async () => {
    const projectUid = newProjectUid()
    await push(projectUid, 0, buildExport({ project: { name: '列表测试' } }))

    const response = await request(ctx.baseUrl, 'GET', '/api/sync/status', { cookie })
    assert.equal(response.status, 200)
    const item = response.json.projects.find(project => project.projectUid === projectUid)
    assert.ok(item)
    assert.equal(item.name, '列表测试')
    assert.equal(item.rev, 1)
    assert.equal(item.tableCount, SYNC_TABLES.length)
    assert.equal(item.export, undefined)
  })

  test('force 覆盖前留 pre-force 快照，可按 rev 取回历史', async () => {
    const projectUid = newProjectUid()
    await push(projectUid, 0, buildExport({ project: { name: '原始版本' } }))

    const forced = await request(ctx.baseUrl, 'POST', '/api/sync/force', {
      cookie,
      body: pushEnvelope({
        projectUid,
        baseRev: 999,
        exportData: buildExport({ project: { name: '覆盖后版本' } }),
      }),
    })
    assert.equal(forced.status, 200)
    assert.equal(forced.json.rev, 2)

    const versions = await request(
      ctx.baseUrl, 'GET', `/api/sync/versions?uid=${projectUid}`, { cookie },
    )
    assert.equal(versions.status, 200)
    const reasons = versions.json.versions.map(version => version.reason)
    assert.ok(reasons.includes('pre-force'), `应含 pre-force，实际 ${reasons.join(',')}`)

    // 回滚：取 rev=1 的历史快照
    const historical = await request(
      ctx.baseUrl, 'GET', `/api/sync/pull?uid=${projectUid}&rev=1`, { cookie },
    )
    assert.equal(historical.status, 200)
    assert.equal(historical.json.historical, true)
    assert.equal(historical.json.export.project.name, '原始版本')
  })

  test('软删除后不再出现在列表，也不能再推送', async () => {
    const projectUid = newProjectUid()
    await push(projectUid, 0, buildExport())

    const deleted = await request(ctx.baseUrl, 'DELETE', `/api/projects/${projectUid}`, { cookie })
    assert.equal(deleted.status, 204)

    const list = await request(ctx.baseUrl, 'GET', '/api/sync/status', { cookie })
    assert.equal(list.json.projects.some(project => project.projectUid === projectUid), false)

    const repush = await push(projectUid, 1, buildExport())
    assert.equal(repush.status, 404)
  })
})
