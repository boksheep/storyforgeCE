/**
 * 结构化日志：每行一个 JSON，只输出标识与规模。
 *
 * 硬规则（对齐 `docs/IP-BACKUP-DESIGN.md` §6 与前端 `settings-snapshot` 的脱敏口径）：
 *   - **绝不记录**手稿正文、`payload_json`、密码、会话 ID、请求体
 *   - IP 只记 `ip_hash` 前缀，不落明文
 *   - 失败日志必须带稳定的 `code`，便于 grep
 */

const SENSITIVE_KEYS = new Set([
  'password', 'passwd', 'passwordHash', 'sid', 'token', 'cookie',
  'payload', 'payloadJson', 'export', 'authorization',
])

function redact(meta) {
  if (!meta || typeof meta !== 'object') return meta
  const out = {}
  for (const [key, value] of Object.entries(meta)) {
    out[key] = SENSITIVE_KEYS.has(key) ? '[redacted]' : value
  }
  return out
}

function write(level, event, meta) {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    event,
    ...redact(meta),
  })
  if (level === 'error') process.stderr.write(`${line}\n`)
  else process.stdout.write(`${line}\n`)
}

export const log = {
  info: (event, meta) => write('info', event, meta),
  warn: (event, meta) => write('warn', event, meta),
  error: (event, meta) => write('error', event, meta),
}
