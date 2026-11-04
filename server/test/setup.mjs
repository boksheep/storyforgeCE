/**
 * 测试环境准备。
 *
 * **必须是每个测试文件的第一个 import**：`src/env.mjs` 在模块求值时读取 `process.env`，
 * 而 ESM 会先求值依赖再执行模块体，所以环境变量只能在"无 src 依赖的模块"里设置。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-cloud-test-'))

process.env.SF_DATA_DIR = dataDir
// 测试用 http + 127.0.0.1：显式允许不安全传输，否则登录会被 400 拦住。
process.env.SF_ALLOW_INSECURE = '1'
// 把上限压小，便于用少量数据测出 413。
process.env.SF_MAX_PUSH_BYTES = String(2 * 1024 * 1024)
process.env.SF_MAX_COMPRESSED_BYTES = String(512 * 1024)
// 让限流用例跑得快一些
process.env.SF_LOGIN_MAX_ATTEMPTS = '3'
process.env.SF_LOGIN_LOCK_AFTER = '5'
// 验证码默认设成"基本不会触发"，避免污染其它用例的失败计数。
// 验证码自己的用例用 withEnv({ captchaAfter: n }) 单独调低。
process.env.SF_CAPTCHA_AFTER = '1000'
process.env.SF_SESSION_TTL_DAYS = '1'
process.env.SF_VERSION_KEEP = '3'
// 云端快照保留上限：压小便于测出轮转
process.env.SF_SNAPSHOT_KEEP = '3'
// 单份快照上限压小，便于测 413
process.env.SF_MAX_SNAPSHOT_BYTES = String(256 * 1024)

export const TEST_DATA_DIR = dataDir
