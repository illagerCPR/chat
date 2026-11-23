-- Cloudflare D1 的表结构。
--
-- 与 server/store/sqlite.ts 里的 SCHEMA 对应，但有两处刻意不同：
--   1. 附件字节存 R2（key = files/<id>），D1 里只留元数据与引用关系，
--      所以 files / staging_files 没有 data 列。
--   2. 版本由 wrangler 的 d1_migrations 表管理，不写 PRAGMA user_version
--      （D1 不允许 PRAGMA，实测返回 SQLITE_AUTH）。
--
-- 单行上限 2 MB，会话正文超限时接口直接回 413，不会写入半条数据。

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  data TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS files (
  id TEXT PRIMARY KEY,
  mime_type TEXT NOT NULL DEFAULT '',
  size INTEGER NOT NULL
);

-- 会话与附件的引用关系：附件只有在无人引用时才回收（字节在 R2）
CREATE TABLE IF NOT EXISTS session_files (
  session_id TEXT NOT NULL,
  file_id TEXT NOT NULL,
  PRIMARY KEY (session_id, file_id)
);

CREATE INDEX IF NOT EXISTS session_files_file ON session_files (file_id);
CREATE INDEX IF NOT EXISTS sessions_updated ON sessions (updated_at DESC);

-- 历史导入的暂存区；提交时在一个 batch 里整体替换正式表
CREATE TABLE IF NOT EXISTS staging_sessions (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  data TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS staging_files (
  id TEXT PRIMARY KEY,
  mime_type TEXT NOT NULL DEFAULT '',
  size INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS staging_session_files (
  session_id TEXT NOT NULL,
  file_id TEXT NOT NULL,
  PRIMARY KEY (session_id, file_id)
);
