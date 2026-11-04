/**
 * Cookie 解析与序列化（只用到会话 cookie，不需要引入依赖）。
 *
 * 会话 cookie 属性：`HttpOnly; Secure; SameSite=Lax; Path=/api`
 *   - `Path=/api`：静态资源请求不带 cookie，减少暴露面
 *   - `SameSite=Lax`：跨站 POST 不带 cookie，配合 Origin 校验形成双层 CSRF 防护
 *   - `Secure`：HTTP 下浏览器会**静默丢弃**，所以登录接口必须先判定协议并明确报错
 */

export function parseCookies(header) {
  const out = new Map()
  if (!header) return out
  for (const part of String(header).split(';')) {
    const index = part.indexOf('=')
    if (index <= 0) continue
    const name = part.slice(0, index).trim()
    const value = part.slice(index + 1).trim()
    if (name) out.set(name, decodeURIComponent(value))
  }
  return out
}

export function serializeCookie(name, value, options = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`]
  parts.push(`Path=${options.path ?? '/api'}`)
  if (options.maxAgeSeconds != null) parts.push(`Max-Age=${Math.floor(options.maxAgeSeconds)}`)
  if (options.httpOnly !== false) parts.push('HttpOnly')
  if (options.secure) parts.push('Secure')
  parts.push(`SameSite=${options.sameSite ?? 'Lax'}`)
  return parts.join('; ')
}

/** 清空会话 cookie（值留空 + Max-Age=0）。 */
export function clearCookie(name, options = {}) {
  return serializeCookie(name, '', { ...options, maxAgeSeconds: 0 })
}
