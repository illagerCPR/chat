import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

/** 当前表结构版本；改动 schema 时递增并补迁移步骤。 */
const SCHEMA_VERSION = 1

/**
 * 会话正文按整份 JSON 保存：前端一次读写整个会话（含消息树），
 * 拆字段只会让写入和分支关系更难维护。列表需要的元信息单独成列。
 */
const SCHEMA = `
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
  size INTEGER NOT NULL,
  data BLOB NOT NULL
);

-- 会话与附件的引用关系：删除会话时级联清理，附件只有在无人引用时才回收
CREATE TABLE IF NOT EXISTS session_files (
  session_id TEXT NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  file_id TEXT NOT NULL,
  PRIMARY KEY (session_id, file_id)
);

CREATE INDEX IF NOT EXISTS session_files_file ON session_files (file_id);
CREATE INDEX IF NOT EXISTS sessions_updated ON sessions (updated_at DESC);

-- 历史导入的暂存区，结构与正式表一致；提交时在一个事务里整体替换
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
  size INTEGER NOT NULL,
  data BLOB NOT NULL
);

CREATE TABLE IF NOT EXISTS staging_session_files (
  session_id TEXT NOT NULL,
  file_id TEXT NOT NULL,
  PRIMARY KEY (session_id, file_id)
);
`

const migrate = (db: DatabaseSync): void => {
  const row = db.prepare('PRAGMA user_version').get() as { user_version?: number } | undefined
  const current = row?.user_version ?? 0
  if (current > SCHEMA_VERSION) {
    throw new Error(
      `Database schema version ${current} is newer than this build supports (${SCHEMA_VERSION}); use a newer image`
    )
  }
  if (current === SCHEMA_VERSION) {
    return
  }
  // 建表语句全部带 IF NOT EXISTS，从 0 升到 1 与重复执行都安全。
  db.exec(SCHEMA)
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`)
}

/** 打开（必要时创建）数据目录下的数据库，并按需建表。 */
export const openDatabase = (dataDir: string): DatabaseSync => {
  mkdirSync(dataDir, { recursive: true })
  const db = new DatabaseSync(path.join(dataDir, 'chat.db'))
  // auto_vacuum 必须在新库建表前设置；删除会话后附件占用的页才会被回收
  db.exec('PRAGMA auto_vacuum = INCREMENTAL')
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA synchronous = NORMAL')
  db.exec('PRAGMA foreign_keys = ON')
  db.exec('PRAGMA busy_timeout = 5000')
  migrate(db)
  return db
}
