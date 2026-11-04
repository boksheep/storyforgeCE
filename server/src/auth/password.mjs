/**
 * 密码哈希：scrypt（Node 内置，零依赖）。
 *
 * ## 为什么选 scrypt 而不是 argon2id
 *
 * 方案原定 argon2id，但 `@node-rs/argon2` 是 native 依赖，会让"零依赖部署"破功
 * （需要按平台分发二进制、进 `npm audit`、容器镜像变大）。scrypt 是
 * `node:crypto` 内置，OWASP 对 scrypt 的推荐参数是 `N=2^15, r=8, p=1`，与 argon2id
 * 同属"内存硬"函数，对私有化单机场景足够。
 *
 * 哈希串**自带算法前缀与参数**，所以将来要换 argon2 只需新增一个分支，
 * 已有哈希无需迁移（登录时按前缀分派，可顺手升级）。
 *
 * 格式：`$scrypt$N=32768,r=8,p=1$<saltBase64>$<hashBase64>`
 */
import crypto from 'node:crypto'
import { promisify } from 'node:util'

const scryptAsync = promisify(crypto.scrypt)

/** OWASP 推荐量级：N=2^15（32768）、r=8、p=1、输出 64 字节。 */
const PARAMS = Object.freeze({ N: 32768, r: 8, p: 1 })
const KEY_LENGTH = 64
const SALT_LENGTH = 16
/** scrypt 的内存需求 ≈ 128 * N * r；必须显式放宽 maxmem。 */
const MAX_MEM = 128 * 1024 * 1024

/** 密码最小长度（不设复杂度规则，避免逼出 `Passw0rd!` 这类弱变体）。 */
export const MIN_PASSWORD_LENGTH = 12

export function assertPasswordStrength(password) {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`密码至少 ${MIN_PASSWORD_LENGTH} 个字符`)
  }
}

export async function hashPassword(password) {
  assertPasswordStrength(password)
  const salt = crypto.randomBytes(SALT_LENGTH)
  const key = await scryptAsync(password, salt, KEY_LENGTH, { ...PARAMS, maxmem: MAX_MEM })
  return `$scrypt$N=${PARAMS.N},r=${PARAMS.r},p=${PARAMS.p}$${salt.toString('base64')}$${key.toString('base64')}`
}

/** 解析自描述哈希串；不认识的算法返回 `null`（调用方按"验证失败"处理）。 */
export function parsePasswordHash(stored) {
  if (typeof stored !== 'string') return null
  const match = stored.match(/^\$scrypt\$N=(\d+),r=(\d+),p=(\d+)\$([A-Za-z0-9+/=]+)\$([A-Za-z0-9+/=]+)$/)
  if (!match) return null
  const [, N, r, p, salt, hash] = match
  return {
    N: Number(N),
    r: Number(r),
    p: Number(p),
    salt: Buffer.from(salt, 'base64'),
    hash: Buffer.from(hash, 'base64'),
  }
}

/**
 * 校验密码。**恒定时**：长度不符也走完 scrypt，只是最后返回 false。
 */
export async function verifyPassword(password, stored) {
  const parsed = parsePasswordHash(stored)
  if (!parsed) return false
  const key = await scryptAsync(password, parsed.salt, parsed.hash.length, {
    N: parsed.N,
    r: parsed.r,
    p: parsed.p,
    maxmem: MAX_MEM,
  })
  if (key.length !== parsed.hash.length) return false
  return crypto.timingSafeEqual(key, parsed.hash)
}

/**
 * 用户不存在时用的"假哈希"。
 *
 * 用途：账号不存在与密码错误必须**耗时同阶**，否则可以按响应时间枚举账号。
 * 这里用固定盐 + 64 字节零值，`verifyPassword` 会照常跑一遍 scrypt 再返回 false。
 */
export const DUMMY_PASSWORD_HASH = `$scrypt$N=${PARAMS.N},r=${PARAMS.r},p=${PARAMS.p}$`
  + `${Buffer.alloc(SALT_LENGTH, 7).toString('base64')}$`
  + `${Buffer.alloc(KEY_LENGTH, 0).toString('base64')}`
