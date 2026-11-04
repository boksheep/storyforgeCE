/**
 * 版本快照的云端存储。
 *
 * 快照**不**走项目同步（`snapshots.data` 本身是整包 JSON，会递归且体积爆炸），
 * 所以这里是独立资源：按需上传、按需拉取、按需删除。
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
} from './helpers.mjs'

let ctx
let cookie
let otherCookie
let projectUid

before(async () => {
  ctx = await startTestServer()
  await createUser(ctx.db, 'owner')
  await createUser(ctx.db, 'intruder')
  cookie = (await login(ctx.baseUrl, 'owner')).cookie
  otherCookie = (await login(ctx.baseUrl, 'intruder')).cookie

  // 快照挂在项目下，所以先让项目在云端存在
  projectUid = newProjectUid()
  const pushed = await request(ctx.baseUrl, 'POST', '/api/sync/push', {
    cookie,
    body: pushEnvelope({ projectUid, baseRev: 0, exportData: buildExport() }),
  })
  assert.equal(pushed.status, 201)
})

after(async () => {
  await ctx.close()
})

function snapshotBody(overrides = {}) {
  return {
    projectUid,
    snapshotUid: crypto.randomUUID(),
    label: '手动备份',
    type: 'manual',
    createdAt: Date.now(),
    data: JSON.stringify(buildExport({ project: { name: '快照内容' } })),
    ...overrides,
  }
}

function upload(body, options = {}) {
  return request(ctx.baseUrl, 'POST', '/api/snapshots', {
    cookie: options.cookie ?? cookie,
    body,
  })
}

function list(uid = projectUid, options = {}) {
  return request(ctx.baseUrl, 'GET', `/api/snapshots?uid=${uid}`, {
    cookie: options.cookie ?? cookie,
  })
}

describe('快照上传与列表', () => {
  test('上传 → 201，列表可见且**不含载荷**', async () => {
    const body = snapshotBody({ label: '第一次手动备份' })
    const response = await upload(body)
    assert.equal(response.status, 201)
    assert.equal(response.json.snapshotUid, body.snapshotUid)
    assert.match(response.json.sha256, /^[0-9a-f]{64}$/)

    const listed = await list()
    assert.equal(listed.status, 200)
    const item = listed.json.snapshots.find(s => s.snapshotUid === body.snapshotUid)
    assert.ok(item)
    assert.equal(item.label, '第一次手动备份')
    assert.equal(item.type, 'manual')
    assert.ok(item.sizeBytes > 0)
    // 列表绝不能带内容：否则"看一眼列表"就等于"下载全部历史"
    assert.equal(item.data, undefined)
    assert.equal(JSON.stringify(listed.json).includes('"data"'), false)
  })

  test('其它用户不能用同一 snapshotUid 覆盖快照', async () => {
    const body = snapshotBody({ label: '不可覆盖' })
    await upload(body)
    const otherProjectUid = newProjectUid()
    const created = await request(ctx.baseUrl, 'POST', '/api/sync/push', {
      cookie: otherCookie,
      body: pushEnvelope({ projectUid: otherProjectUid, baseRev: 0, exportData: buildExport() }),
    })
    assert.equal(created.status, 201)
    const response = await upload({
      ...body,
      projectUid: otherProjectUid,
      snapshotUid: body.snapshotUid,
      data: JSON.stringify(buildExport({ project: { name: '攻击载荷' } })),
    }, { cookie: otherCookie })
    assert.equal(response.status, 409)
    const fetched = await request(ctx.baseUrl, 'GET', `/api/snapshots/${body.snapshotUid}`, { cookie })
    assert.equal(fetched.json.label, '不可覆盖')
  })

  test('同一 snapshotUid 重复上传是幂等的（不产生两条）', async () => {
    const body = snapshotBody({ label: '幂等验证' })
    await upload(body)
    await upload({ ...body, label: '幂等验证（改名）' })

    const listed = await list()
    const same = listed.json.snapshots.filter(s => s.snapshotUid === body.snapshotUid)
    assert.equal(same.length, 1)
    assert.equal(same[0].label, '幂等验证（改名）')
  })

  test('取回内容与上传逐字节一致', async () => {
    const body = snapshotBody({ label: '取回验证' })
    await upload(body)

    const fetched = await request(
      ctx.baseUrl, 'GET', `/api/snapshots/${body.snapshotUid}`, { cookie },
    )
    assert.equal(fetched.status, 200)
    assert.equal(fetched.json.data, body.data)
    assert.equal(fetched.json.label, '取回验证')
  })

  test('快照类型非法 → 422', async () => {
    const response = await upload(snapshotBody({ type: 'weird' }))
    assert.equal(response.status, 422)
    assert.equal(response.json.error.code, 'bad_type')
  })

  test('内容不是合法 JSON → 422', async () => {
    const response = await upload(snapshotBody({ data: '{not json' }))
    assert.equal(response.status, 422)
    assert.equal(response.json.error.code, 'bad_data')
  })

  test('内容不是字符串 → 422（保持"客户端已序列化"契约）', async () => {
    const response = await upload(snapshotBody({ data: { a: 1 } }))
    assert.equal(response.status, 422)
    assert.equal(response.json.error.code, 'bad_data')
  })

  test('快照标识非法 → 400', async () => {
    const response = await upload(snapshotBody({ snapshotUid: '../../etc/passwd' }))
    assert.equal(response.status, 400)
    assert.equal(response.json.error.code, 'bad_snapshot_uid')
  })

  test('超过单份上限 → 413', async () => {
    const huge = JSON.stringify({ ...buildExport(), filler: 'x'.repeat(300 * 1024) })
    const response = await upload(snapshotBody({ data: huge }))
    assert.equal(response.status, 413)
  })
})

describe('快照越权与生命周期', () => {
  test('项目不存在 → 404（必须先同步过项目）', async () => {
    const response = await upload(snapshotBody({ projectUid: newProjectUid() }))
    assert.equal(response.status, 404)
  })

  test('他人项目不能上传 → 404', async () => {
    const response = await upload(snapshotBody(), { cookie: otherCookie })
    assert.equal(response.status, 404)
  })

  test('他人快照不能读、不能删 → 404', async () => {
    const body = snapshotBody({ label: '私有快照' })
    await upload(body)

    const read = await request(
      ctx.baseUrl, 'GET', `/api/snapshots/${body.snapshotUid}`, { cookie: otherCookie },
    )
    assert.equal(read.status, 404)

    const removed = await request(
      ctx.baseUrl, 'DELETE', `/api/snapshots/${body.snapshotUid}`, { cookie: otherCookie },
    )
    assert.equal(removed.status, 404)
  })

  test('删除 → 204，之后取回 404', async () => {
    const body = snapshotBody({ label: '待删除' })
    await upload(body)

    const removed = await request(
      ctx.baseUrl, 'DELETE', `/api/snapshots/${body.snapshotUid}`, { cookie },
    )
    assert.equal(removed.status, 204)

    const fetched = await request(
      ctx.baseUrl, 'GET', `/api/snapshots/${body.snapshotUid}`, { cookie },
    )
    assert.equal(fetched.status, 404)
  })

  test('超过保留上限时删最旧（SF_SNAPSHOT_KEEP=3）', async () => {
    const isolated = newProjectUid()
    await request(ctx.baseUrl, 'POST', '/api/sync/push', {
      cookie,
      body: pushEnvelope({ projectUid: isolated, baseRev: 0, exportData: buildExport() }),
    })

    const base = Date.now()
    const created = []
    for (let index = 0; index < 5; index += 1) {
      const body = snapshotBody({ projectUid: isolated, label: `第 ${index} 份`, createdAt: base + index * 1000 })
      const response = await upload(body)
      assert.equal(response.status, 201)
      created.push(body.snapshotUid)
    }

    const listed = await list(isolated)
    assert.equal(listed.json.snapshots.length, 3)
    const remaining = listed.json.snapshots.map(s => s.snapshotUid)
    // 最新的三份保留，最旧的两份被删
    assert.deepEqual(remaining, [created[4], created[3], created[2]])
  })

  test('未登录 → 401', async () => {
    const response = await request(ctx.baseUrl, 'GET', `/api/snapshots?uid=${projectUid}`)
    assert.equal(response.status, 401)
  })
})
