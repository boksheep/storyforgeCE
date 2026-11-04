# StoryForge 云数据库服务

私有化部署用的同步后端：账号登录 + 项目级云数据库。

**零运行时依赖** —— 只用 Node 内置模块：

| 需求 | 用的东西 | 为什么不用生态包 |
|---|---|---|
| HTTP | `node:http` | 路由只有 11 条，自己写反而更小更可控 |
| 数据库 | `node:sqlite`（Node ≥ 22.5） | 免 native 编译、免 `npm install`、镜像里只有源码 |
| 密码哈希 | `node:crypto` scrypt | 避免 native 依赖；OWASP 对 scrypt 的推荐参数与 argon2id 同属内存硬 |
| 压缩 | `node:zlib` | 需要**流式**解压才能防 gzip 炸弹，第三方封装反而挡路 |

因此部署时**不需要** `npm install`，也没有 `npm audit` 噪声。

> **在 CE 分发仓库里**：本目录会完整同步过去（`scripts/ce-sync.mjs` 不排除 `server/`），
> 但 `docs/` 与 `packaging/` 属于上游开发仓库、不进 CE。所以本文件里提到的
> `docs/CLOUD-DB-*.md`、`packaging/web-cloud-db/` 等路径在 CE 仓库中不存在——
> 部署编排请到上游仓库取，或按下面的 `.env.example` + `Dockerfile` 自己写 compose。

---

## 快速开始（本机）

```bash
cd server
SF_DATA_DIR=./data SF_ALLOW_INSECURE=1 node --disable-warning=ExperimentalWarning src/index.mjs

# 另开一个终端
node scripts/create-user.mjs me --password-stdin        # 输入至少 12 位密码
node scripts/smoke.mjs --base http://127.0.0.1:8787 --username me --password-stdin
npm test                                                 # 40 项
```

`SF_ALLOW_INSECURE=1` 只用于本机 HTTP 调试；生产必须为 `0` 并挂 HTTPS。

---

## 目录

```
src/
├── index.mjs           HTTP 入口与路由表
├── env.mjs             环境变量与安全默认值
├── db.mjs              SQLite 打开 + BEGIN IMMEDIATE 事务
├── schema.sql          表结构（含设计取舍说明）
├── log.mjs             结构化日志 + 脱敏
├── http/
│   ├── respond.mjs     HttpError / sendJson / sendError（统一 no-store）
│   ├── cookies.mjs     Cookie 解析与序列化
│   └── body.mjs        流式解压 + 双上限（防 gzip 炸弹）
├── auth/
│   ├── password.mjs    scrypt 自描述哈希 + 假哈希（防账号枚举）
│   ├── session.mjs     不透明 sid，库里只存 sha256
│   └── routes.mjs      登录/登出/me + CSRF + 限流 + 会话守卫
├── sync/
│   ├── content-hash.mjs  规范化哈希（剔除 exportedAt）
│   ├── validate.mjs      Push 信封校验（55 张表必须全在）
│   ├── store.mjs         装配 export / 版本快照 / 清理
│   ├── push.mjs          推送 + 幂等 + 乐观锁 + 强制覆盖
│   ├── pull.mjs          拉取（含历史版本、304）
│   └── status.mjs        列表 / 状态 / 软删除 / 版本列表
└── generated/
    └── table-manifest.mjs  由 scripts/gen-cloud-sync-manifest.mjs 派生
scripts/
├── create-user.mjs     建号 / 改密 / 禁用 / 列号
├── backup.mjs          VACUUM INTO 在线备份 + 轮转
└── smoke.mjs           部署自检（登录→推送→拉取→比对→清理）
```

---

## API

所有接口在 `/api` 下，所有响应带 `Cache-Control: no-store`。
变更类请求（POST/DELETE）需要 `X-SF-Client: storyforge` 且 `Origin` 可信。

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| GET | `/api/config` | 无 | `{app, cloud, protocol, exportVersion, syncTableCount, maxPushBytes}` |
| GET | `/api/health` | 无 | 数据库异常时 503 |
| POST | `/api/auth/login` | 限流（+ 触发阈值后要验证码） | 204 + Set-Cookie；400（含 `captcha_required` / `captcha_invalid`）/401/423/429 |
| GET | `/api/auth/captcha` | 发码频率 | `{id, image, expiresInSec}`；`image` 是 `data:image/svg+xml;base64,…` |
| POST | `/api/auth/logout` | 会话 | 204 + 清 cookie |
| GET | `/api/auth/me` | 会话 | `{user, expiresAt}` |
| GET | `/api/projects` | 会话 | 同 `/api/sync/status` |
| DELETE | `/api/projects/:uid` | 会话 | 204，软删除 |
| GET | `/api/sync/status` | 会话 | 项目元数据列表（**不含载荷**） |
| GET | `/api/sync/pull?uid=&rev=&sinceRev=` | 会话 | 完整 export；`sinceRev===rev` → 304 |
| GET | `/api/sync/versions?uid=` | 会话 | 历史版本元数据 |
| POST | `/api/sync/push` | 会话 | 201/200；409 冲突；413 超限；422 结构错 |
| POST | `/api/sync/force` | 会话 | 忽略 `baseRev`，覆盖前写 `pre-force` 快照 |
| GET | `/api/snapshots?uid=` | 会话 | 云端版本快照列表（**只有元数据**） |
| POST | `/api/snapshots` | 会话 | 上传/覆盖一份快照（按 `snapshotUid` 幂等） |
| GET | `/api/snapshots/:snapshotUid` | 会话 | 取回完整内容（用于恢复） |
| DELETE | `/api/snapshots/:snapshotUid` | 会话 | 204 |

### Push 信封

```jsonc
{
  "protocol": 1,
  "opId": "uuid",            // 客户端持久化；重试必须复用同一个
  "projectUid": "uuid",
  "baseRev": 7,              // 0 表示"新建"
  "clientId": "web-abc",
  "export": { /* ProjectExportData，55 张表键必须齐全 */ }
}
```

`Content-Encoding: gzip` 可选（推荐：百万字项目 ~1.5 MB → ~300 KB）。

---

## 关键设计决策

### 1. 不建 67 张业务镜像表

`project_tables.payload_json` 存整表 JSON。理由与代价写在 `src/schema.sql` 头部。
一句话：**服务端对前端 schema 演进免疫**（55 张表加字段，服务端零改动），
代价是放弃服务端全文检索与行级同步（升级路径已预留）。

### 2. 同步单元是"整包"，不是"单表"

前端导出用 `exportRemap` 把外键换成**表内下标**（`_exportId`）。
任一张表的行序变化都会让别的表的下标失效，所以"只传变化的表"这种增量协议是错的。
正确形态：整包一致传输 + 服务端按表落盘 + 表级 sha256 跳过未变表。

### 3. 哈希必须剔除 `exportedAt`

`deriveExportProjectJSON` 每次导出都写 `exportedAt: Date.now()`。
不剔除它，"内容没变就跳过"永远不命中，会退化成每 45 秒全量上传。
`content-hash.mjs` 与前端 `src/lib/cloud/integrity.ts` 必须用同一套规范化规则。

### 4. 幂等靠 `opId`，不靠 `baseRev`

推送成功但响应丢失时客户端会重试。若重试重新生成 `opId`，服务端会因 `baseRev`
过期返回 409，用户看到"冲突"并可能误选"覆盖云端"。
所以 `opId` 必须**持久化在客户端脏集里**，只在收到成功响应后才换新的。

### 5. 同步通道**不做**端到端加密

加密后服务端只有密文 → 无法做表级哈希比对、无法 409 冲突检测、无法给远端摘要。
这与"云数据库"目标互斥。要求"服务端不可读"时，用客户端加密的整包备份通道
（`docs/IP-BACKUP-DESIGN.md` 的 `/api/backup`），而不是加密的增量同步。
**不要在宣传里说"服务端看不到你的手稿"** —— 那是假的。

### 6. 服务端可读手稿，因此必须限制谁能连上

私有化部署的前提：只有你和少数几个人用。管理员建号、关闭注册、限流、HTTPS。
如果将来要开放注册，需要另做权限与配额模型，不能直接把这个服务暴露出去。

### 6.1 账号密码怎么设：**不能手写文件，但可以让脚本读文件**

数据库里存的是 **scrypt 哈希**（`$scrypt$N=32768,r=8,p=1$salt$hash`），不是明文。
手写一个 `用户名:密码` 的文本文件塞进 SQLite，只会得到一个永远登录不上的坏账号。

想"用文件代替手输密码"，正确做法是把**明文喂给脚本**，由它算哈希：

```bash
# 单个账号：文件第一行是密码（后面的行会被忽略）
node scripts/create-user.mjs alice --password-file ./pw.txt
# 也可以用标准输入
node scripts/create-user.mjs alice --password-file -

# 批量账号（JSON 数组，或 { "users": [...] }）
node scripts/create-user.mjs --import ./users.json
node scripts/create-user.mjs --import ./users.json --update-existing   # 覆盖已存在账号的密码
```

`--import` 是**先全量校验、再单事务写入**：只要有一条用户名不合法或密码不足 12 位，
**一个账号都不会写**，并列出全部问题行。避免"一半成功"难以收拾。
已存在的账号默认**跳过**（不覆盖密码），要覆盖必须显式加 `--update-existing`。
脚本读完不保留明文，导出文件请自行删除。

### 6.2 防轰炸：两层限流，两层都有内存上限

| 层 | 键 | 阈值（默认） | 挡什么 |
|---|---|---|---|
| ① 单账号 | `IP + 用户名` | 窗口 15 min 内 5 次 → 429；连续 10 次 → 锁 15 min（423） | 盯着一个账号猛试 |
| ② IP 全局 | `IP` | 窗口 15 min 内 30 次 → 429 `ip_rate_limited` | **密码喷洒**（一份密码把所有账号各试一次） |

只有 ① 是不够的：攻击者换一个用户名就换一套独立计数，喷洒完全不受限。② 就是补这个洞。

两层表都是 `Map`，键由**请求内容**决定，所以必须有硬上限：
`SF_LOGIN_TRACK_MAX`（默认 5000）超了就按最早时间淘汰。没有它，攻击者用海量随机
用户名可以让表无界增长到 OOM —— 这是一条比暴力破解更省力的 DoS 路径。

登录成功**只清 ① 不清 ②**：否则攻击者只要手里有一个自己的账号，就能用
"错 4 次 + 成功 1 次"把喷洒额度无限续上。

### 6.3 注入：全参数绑定，零字符串拼接

所有 SQL 一律 `db.prepare('... WHERE username = ?').get(username)`，
**没有一处**把用户输入拼进 SQL（`grep "prepare(\`"` 与 `prepare(.*\$\{` 均为空）。
登录体上限 8 KiB，超长用户名（> 64）按"密码错误"处理，既不让它成为限流表里的巨型键，
也不泄露任何信息。

### 6.4 CSRF：建议显式设置 `SF_PUBLIC_ORIGIN`

来源白名单默认按请求的 `Host` 头推导。理论上伪造 `Host` 能让 `Origin` 校验"自己和自己对上"，
所以**建议显式设置** `SF_PUBLIC_ORIGIN=https://你的域名`：设了之后只认它，不再看 `Host`。
另两层是 `SameSite=Lax` 与自定义头 `X-SF-Client`（跨源预检会失败，因为我们不返回 CORS 允许头）。

### 6.5 SQLite 用 WAL

`openDatabase()` 会设 `journal_mode=WAL` + `busy_timeout=5000` + `synchronous=NORMAL`。
没有 WAL，`backup.mjs` / `create-user.mjs` 这类**外部进程**与服务端同时访问时很容易
撞上 `SQLITE_BUSY`。WAL 是写进库文件的持久设置，对已有库执行一次即生效。

### 6.6 图形验证码（服务端生成 SVG，零依赖）

限流挡的是"同一 IP 高频尝试"，挡不住**分布式低速撞库**（每个 IP 每小时只试几次）。
验证码把"每次尝试都需要一次真人动作"变成硬约束。

**流程**（判定权完全在服务端）：

```
① 用户提交账号密码
② 服务端看这个 IP 在窗口内的失败次数 ≥ SF_CAPTCHA_AFTER？
     否 → 正常校验密码
     是 → 没带 captchaId/captchaAnswer → 400 captcha_required
          带了 → 先验验证码，过了才校验密码
③ 前端收到 captcha_required（或 401 里带 captchaRequired:true）→
   GET /api/auth/captcha 取一张 → 用户填 → 重提交
```

**关键设计**：

| 决策 | 理由 |
|---|---|
| 用 **SVG + data URI**，不是 PNG | 零依赖（不需要 canvas/sharp）；`<img>` 上下文里的 SVG **不会执行脚本**、不加载外部资源 |
| 字体交给**客户端**解析 | SVG 由浏览器渲染，alpine 镜像里没有字体文件也没关系 |
| 挑战**绑定 IP** | 从 A 处拿到的题不能拿到 B 处用 |
| 挑战**一次性**，答错也作废 | 否则可以拿同一张图反复试答案（5 位 × 32 字母表 = 3355 万） |
| 答案比对用 `timingSafeEqual` | 不给按响应时间猜字符的机会 |
| 答错**也计入失败次数** | 否则等于"无限次免费试验证码"，把限流绕过去了 |
| 判定看**服务端状态** | 客户端传什么都不影响"要不要验证码"，否则说一句"我不需要"就绕过了 |
| 挑战表有**硬上限** + 发码频率限制 | 否则"疯狂拉验证码"本身就是一条打满内存的路径 |

**配置**：

```bash
SF_CAPTCHA_AFTER=3        # 失败 3 次后开始要求；0=每次都要；负数=关闭
SF_CAPTCHA_TTL_SECONDS=300
SF_CAPTCHA_STORE_MAX=2000 # 挑战表条目上限
SF_CAPTCHA_ISSUE_MAX=60   # 单 IP 在窗口内最多拉多少张
```

**强度边界（如实说明）**：这是自制图形码，字符做了旋转、抖动、噪点、干扰线，
但对成熟 OCR 模型不算强。定位是"抬高脚本成本 + 与限流叠加"，**不是唯一防线**。
真要对外开放请在前面加 WAF / 商业验证码。

---

## 测试

```bash
npm test
```

81 项，分六组：

- `test/auth.test.mjs`（13）：cookie 属性、账号枚举同形、CSRF、限流 429/423、
  会话失效、`no-store`。
- `test/sync.test.mjs`（14）：创建/幂等重放/未变跳过/409 摘要/缺表 422/
  往返逐字段一致/304/越权 404/force 快照/软删除。
- `test/security.test.mjs`（11）：**gzip 炸弹 413 且不改 rev**、正常 gzip 可用、
  超大 Content-Length、非 JSON、协议版本、projectUid 校验、opId 跨项目复用、历史版本越权。
- `test/snapshots.test.mjs`（15）：上传/列表不含载荷/幂等覆盖/取回一致/类型与内容校验/
  单份上限 413/项目不存在 404/越权 404/删除/保留上限轮转/未登录 401。
- `test/hardening.test.mjs`（14）：**密码喷洒被 IP 全局限流拦下**、限流表有硬上限、
  超长用户名 401、用户名/密码里的 SQL 注入串被当普通字符串、伪造 Host 不通过 CSRF、
  `--password-file` / `--password-file -` / `--import` 三种文件建号、非法导入一个都不写、
  库里存的是 `$scrypt$` 哈希而非明文。
- `test/captcha.test.mjs`（14）：签发返回 SVG data URI 且不含脚本、未达阈值不要求、
  达阈值缺码 400、答对通过、大小写不敏感、**答错即作废**、用过即作废、过期、
  **绑 IP**、发码频率 429、挑战表硬上限、答错计入失败、`-1` 关闭。

### 7. 版本快照是**独立资源**，不并进项目同步

`snapshots.data` 本身就是一份完整的 `ProjectExportData`：

- 放进 `project_tables` 会"整包套整包"
- 每项目最多 20 份 × ~1.5 MB ≈ 30 MB，会让**每次** push 都重传全部历史，还会顶穿 64 MiB 上限
- 快照是"可选上传"的，不该被自动同步带走

所以它是单表 + 独立端点（`/api/snapshots`），按需上传、按需拉取。
`snapshot_uid` 由**客户端**生成并在上传前落盘，因此重试是幂等的。

---

## 维护

- 会话每小时清理一次过期项；`sync_log` 保留 30 天（幂等窗口）。
- 版本快照每项目保留 `SF_VERSION_KEEP` 份（默认 20），超出自动删文件与索引。
- 日志只记 `userId / projectUid / rev / size / 错误码`，IP 存 16 位哈希前缀。
