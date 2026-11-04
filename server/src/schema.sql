-- StoryForge 云数据库 · SQLite schema
--
-- 设计取舍：**不建 67 张业务镜像表**，而是用 `project_tables.payload_json` 存整表 JSON。
-- 理由：
--   1. 镜像表会成为"第二套必须与 SCHEMA_VERSION（已 54 版）同步演进"的物理 schema，
--      前端每加一个字段都要写两份迁移；而 `check:required-tables` 存在的意义就是防这种漂移。
--   2. 服务端从不需要按业务字段查询，只查 owner / name / rev / updated_at / size，
--      这些都在 `projects` 的显式列上。
--   3. 因此服务端对前端演进**免疫**：55 张表加任意字段，这里零改动。
-- 代价：放弃服务端全文检索与行级同步。升级路径已预留（payload_json 可拆成 rows 表，API 不变）。

PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;

-- ── 账号 ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  username            TEXT    NOT NULL UNIQUE,
  -- 带算法前缀的自描述哈希，例如 `$scrypt$N=32768,r=8,p=1$<salt>$<hash>`
  password_hash       TEXT    NOT NULL,
  role                TEXT    NOT NULL DEFAULT 'author' CHECK (role IN ('admin', 'author')),
  disabled            INTEGER NOT NULL DEFAULT 0 CHECK (disabled IN (0, 1)),
  created_at          INTEGER NOT NULL,
  password_changed_at INTEGER NOT NULL
);

-- ── 会话 ──────────────────────────────────────────────────────────────
-- 只存 sha256(sid)，拖库不能直接冒用会话。
CREATE TABLE IF NOT EXISTS sessions (
  id_hash      TEXT    PRIMARY KEY,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at   INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  ua_hash      TEXT,
  ip_hash      TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

-- ── 项目 ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS projects (
  project_uid        TEXT    PRIMARY KEY,
  owner_user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name               TEXT    NOT NULL,
  rev                INTEGER NOT NULL DEFAULT 0,
  export_version     INTEGER NOT NULL DEFAULT 4,
  app_schema_version INTEGER,
  content_sha256     TEXT,
  size_bytes         INTEGER NOT NULL DEFAULT 0,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL,
  deleted_at         INTEGER
);
CREATE INDEX IF NOT EXISTS idx_projects_owner ON projects(owner_user_id, deleted_at);

-- ── 表级载荷 ──────────────────────────────────────────────────────────
-- 每行 = 一张同步表在该 rev 下的完整 JSON 数组。
-- `sha256` 用于 push 时跳过未变表（省写入、也用于 409 摘要的 changedTables）。
CREATE TABLE IF NOT EXISTS project_tables (
  project_uid  TEXT    NOT NULL REFERENCES projects(project_uid) ON DELETE CASCADE,
  table_name   TEXT    NOT NULL,
  rev          INTEGER NOT NULL,
  sha256       TEXT    NOT NULL,
  row_count    INTEGER NOT NULL,
  payload_json TEXT    NOT NULL,
  PRIMARY KEY (project_uid, table_name)
);

-- ── 版本历史 ──────────────────────────────────────────────────────────
-- 每次成功 push 存一份**推送后**的快照，用于回滚到任意历史 rev。
CREATE TABLE IF NOT EXISTS project_versions (
  project_uid      TEXT    NOT NULL REFERENCES projects(project_uid) ON DELETE CASCADE,
  rev              INTEGER NOT NULL,
  content_sha256   TEXT    NOT NULL,
  size_bytes       INTEGER NOT NULL,
  reason           TEXT    NOT NULL CHECK (reason IN ('push', 'pre-force', 'pre-pull', 'import')),
  payload_path     TEXT,
  created_at       INTEGER NOT NULL,
  PRIMARY KEY (project_uid, rev, reason)
);

-- ── 版本快照（手动 / 自动）────────────────────────────────────────────
-- 为什么**不**并进 `project_tables`：
--   1. `snapshots.data` 本身就是一份完整的 `ProjectExportData`，放进去会递归
--   2. 每项目最多 20 份 × 1.5 MB ≈ 30 MB，会让每次 push 都传一遍历史，且顶穿 64 MiB 上限
--   3. 快照是"独立可选上传"的，不该跟随项目同步自动推送
-- 因此单表 + 独立端点，按需上传、按需拉取。
CREATE TABLE IF NOT EXISTS project_snapshots (
  -- 客户端生成，设备无关：同一份快照重复上传是幂等的（不会产生两条）
  snapshot_uid  TEXT    PRIMARY KEY,
  project_uid   TEXT    NOT NULL REFERENCES projects(project_uid) ON DELETE CASCADE,
  owner_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label         TEXT    NOT NULL,
  type          TEXT    NOT NULL CHECK (type IN ('auto', 'manual')),
  size_bytes    INTEGER NOT NULL,
  sha256        TEXT    NOT NULL,
  payload_json  TEXT    NOT NULL,
  created_at    INTEGER NOT NULL,
  uploaded_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_project_snapshots_project
  ON project_snapshots(project_uid, created_at DESC);

-- ── 幂等日志 ──────────────────────────────────────────────────────────
-- 推送成功但响应丢失时，客户端用同一个 opId 重试 → 这里命中 → 返回当时的 rev（200，不是 409）。
CREATE TABLE IF NOT EXISTS sync_log (
  op_id       TEXT    PRIMARY KEY,
  project_uid TEXT    NOT NULL,
  rev         INTEGER NOT NULL,
  applied_at  INTEGER NOT NULL
);

-- ── 审计 ──────────────────────────────────────────────────────────────
-- 只记标识与规模，不记正文、不记 token。
CREATE TABLE IF NOT EXISTS audit_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  at          INTEGER NOT NULL,
  user_id     INTEGER,
  action      TEXT    NOT NULL,
  project_uid TEXT,
  detail      TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_at ON audit_log(at);
