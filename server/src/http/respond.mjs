/**
 * HTTP 响应工具：统一错误体、统一 `no-store`。
 *
 * 所有 `/api/*` 响应都带 `Cache-Control: no-store` —— 手稿不得进浏览器缓存或反向代理缓存。
 */

export class HttpError extends Error {
  /**
   * @param {number} status HTTP 状态码
   * @param {string} code 稳定错误码（前端按它映射文案）
   * @param {string} message 人类可读说明（**不含敏感信息**）
   * @param {object} [extra] 附加字段（如 409 的 remote 摘要）
   * @param {Record<string,string>} [headers] 额外响应头（如 `Retry-After`）
   */
  constructor(status, code, message, extra, headers) {
    super(message)
    this.name = 'HttpError'
    this.status = status
    this.code = code
    this.extra = extra
    this.headers = headers
  }
}

const BASE_HEADERS = Object.freeze({
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
})

export function sendJson(res, status, body, extraHeaders = {}) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    ...BASE_HEADERS,
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    ...extraHeaders,
  })
  res.end(payload)
}

export function sendNoContent(res, extraHeaders = {}) {
  res.writeHead(204, { ...BASE_HEADERS, ...extraHeaders })
  res.end()
}

/** 统一错误体：`{ error: { code, message, ...extra } }`。 */
export function sendError(res, error) {
  if (error instanceof HttpError) {
    sendJson(
      res,
      error.status,
      {
        error: { code: error.code, message: error.message },
        ...(error.extra ?? {}),
      },
      error.headers ?? {},
    )
    return
  }
  sendJson(res, 500, {
    error: { code: 'internal', message: '服务器内部错误' },
  })
}
