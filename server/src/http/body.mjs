/**
 * 请求体读取：**流式**解压 + 双上限。
 *
 * 安全要点：gzip 炸弹是真实风险 —— 1 KiB 压缩流可以膨胀到 GB 级。
 * 因此这里：
 *   1. 先按 `Content-Length` 卡压缩后体积（第一道）
 *   2. 用 `createGunzip()` **流式**解压，累计**输出**字节超限立即 `destroy()`
 *   3. **绝不** `gunzipSync` 整体解压（那正是炸弹的引爆方式）
 */
import zlib from 'node:zlib'
import { env } from '../env.mjs'
import { HttpError } from './respond.mjs'

/**
 * 超限错误的统一形状。
 *
 * 带 `connection: close`：我们在读完请求体之前就拒绝，若复用连接，
 * 未消费的字节会污染下一次请求（表现为客户端 `socket hang up`）。
 */
function tooLarge(limit) {
  return new HttpError(
    413,
    'too_large',
    `请求体超过上限（${Math.floor(limit / 1024 / 1024)} MiB）`,
    undefined,
    { connection: 'close' },
  )
}

/**
 * 把可读流收集成 Buffer，超过 `limit` 立刻中止。
 *
 * ## 为什么超限时**不能** `upstream.destroy()`
 *
 * 早期实现直接销毁上游请求 socket，结果客户端拿到的是 `ECONNRESET` 而不是 413 ——
 * 因为 socket 已经没了，响应根本没机会写出去。用户看到的是"网络错误"，
 * 完全无法判断是"文件太大"。
 *
 * 正确做法：停掉解压流（自己的），把剩余字节**丢弃**（`resume()`），
 * 再靠 `connection: close` 让这条连接干净收尾。响应因此能正常送达。
 *
 * @param {import('node:stream').Readable} stream 数据源（gzip 时是解压流）
 * @param {number} limit 字节上限
 * @param {import('node:http').IncomingMessage} upstream 原始请求（只用来丢弃剩余字节）
 */
function collectWithCap(stream, limit, upstream) {
  return new Promise((resolve, reject) => {
    let total = 0
    let settled = false
    const chunks = []

    function cleanup() {
      stream.off('data', onData)
      stream.off('end', onEnd)
      stream.off('error', onError)
    }

    function fail(error) {
      if (settled) return
      settled = true
      cleanup()
      reject(error)
    }

    function onData(chunk) {
      total += chunk.length
      if (total > limit) {
        // 只停自己的解压流；上游继续 drain，保证响应能写出去
        if (stream !== upstream) stream.destroy()
        upstream.resume()
        fail(tooLarge(limit))
        return
      }
      chunks.push(chunk)
    }

    function onEnd() {
      if (settled) return
      settled = true
      cleanup()
      resolve(Buffer.concat(chunks))
    }

    function onError(error) {
      fail(error)
    }

    stream.on('data', onData)
    stream.on('end', onEnd)
    stream.on('error', onError)
  })
}

/**
 * 读取并解析 JSON 请求体。
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {{ maxBytes?: number, maxCompressedBytes?: number }} [options]
 */
export async function readJsonBody(req, options = {}) {
  const maxBytes = options.maxBytes ?? env.maxPushBytes
  const maxCompressedBytes = options.maxCompressedBytes ?? env.maxCompressedBytes

  const encoding = String(req.headers['content-encoding'] ?? '').toLowerCase()
  const isGzip = encoding.includes('gzip')

  const declared = Number.parseInt(String(req.headers['content-length'] ?? ''), 10)
  if (Number.isFinite(declared) && declared > maxCompressedBytes) {
    // 不读、直接拒绝；`connection: close` 让连接不被复用
    req.resume()
    throw tooLarge(maxCompressedBytes)
  }

  const limit = isGzip ? maxBytes : Math.min(maxBytes, maxCompressedBytes)
  const source = isGzip ? req.pipe(zlib.createGunzip()) : req

  // 客户端提前断开 / 我们主动停掉解压流时，req 可能发出 'error'。
  // 没有监听器会变成未捕获异常直接把进程带走，所以挂一个空处理器。
  req.on('error', () => {})

  let buffer
  try {
    buffer = await collectWithCap(source, limit, req)
  } catch (error) {
    if (error instanceof HttpError) throw error
    throw new HttpError(400, 'bad_body', '请求体读取失败，或不是合法的 gzip 数据')
  }

  if (buffer.length === 0) throw new HttpError(400, 'bad_body', '请求体为空')

  try {
    return JSON.parse(buffer.toString('utf8'))
  } catch {
    throw new HttpError(400, 'bad_json', '请求体不是合法 JSON')
  }
}
