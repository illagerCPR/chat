import { retypeSessionJson } from '../core/validate.ts'
import type { ChatStore, FileInput, SessionInput, SessionSummary, StoredFileBody } from './types.ts'

/**
 * D1 与 R2 的最小结构化类型。这里刻意不依赖 @cloudflare/workers-types：
 * server/ 的 tsconfig 只有 node 类型，而 Worker 侧传进来的官方对象只要
 * 结构满足即可（官方类型是这里的超集）。
 */
export type D1Value = string | number | null | Uint8Array

export type D1PreparedStatementLike = {
  bind(...values: D1Value[]): D1PreparedStatementLike
  first<T = unknown>(): Promise<T | null>
  all<T = unknown>(): Promise<{ results: T[] }>
  run(): Promise<{ meta: { changes: number } }>
}

export type D1DatabaseLike = {
  prepare(query: string): D1PreparedStatementLike
  batch(statements: D1PreparedStatementLike[]): Promise<unknown[]>
}

export type R2ObjectBodyLike = {
  size: number
  httpMetadata?: { contentType?: string }
  body: ReadableStream<Uint8Array>
}

export type R2BucketLike = {
  put(
    key: string,
    value: Uint8Array,
    options?: { httpMetadata?: { contentType?: string } }
  ): Promise<unknown>
  get(key: string): Promise<R2ObjectBodyLike | null>
  delete(keys: string | string[]): Promise<void>
}

/** D1 的 batch 上限，官方按 100 条语句算；留一条余量给同批的辅助语句。 */
const MAX_BATCH_STATEMENTS = 99
/** D1 单条语句的绑定参数上限是 100，IN (...) 的占位符按 90 个留余量。 */
const MAX_IN_PARAMS = 90

const chunked = <T>(items: readonly T[], size: number): T[][] => {
  const result: T[][] = []
  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size))
  }
  return result
}

/** R2 的 key 前缀：附件与导入暂存共用同一份字节，导入提交时不需要搬对象。 */
const fileKey = (id: string): string => `files/${id}`

const UPSERT_SESSION = `INSERT INTO sessions (id, title, created_at, updated_at, data)
  VALUES (?, ?, ?, ?, ?)
  ON CONFLICT (id) DO UPDATE SET
    title = excluded.title,
    created_at = excluded.created_at,
    updated_at = excluded.updated_at,
    data = excluded.data`

const UPSERT_FILE = `INSERT INTO files (id, mime_type, size) VALUES (?, ?, ?)
  ON CONFLICT (id) DO UPDATE SET
    mime_type = excluded.mime_type,
    size = excluded.size`

const UPSERT_STAGING_SESSION = `INSERT INTO staging_sessions (id, title, created_at, updated_at, data)
  VALUES (?, ?, ?, ?, ?)
  ON CONFLICT (id) DO UPDATE SET
    title = excluded.title,
    created_at = excluded.created_at,
    updated_at = excluded.updated_at,
    data = excluded.data`

const UPSERT_STAGING_FILE = `INSERT INTO staging_files (id, mime_type, size) VALUES (?, ?, ?)
  ON CONFLICT (id) DO UPDATE SET
    mime_type = excluded.mime_type,
    size = excluded.size`

/**
 * Cloudflare 实现：会话正文与元数据在 D1，附件字节在 R2。
 *
 * D1 没有交互式事务，多表写入一律走 batch（整批原子）；读改写做不到原子，
 * 只用在「改名」和「暂存补 MIME」两处 —— 前者已经收敛成一条 UPDATE，
 * 后者只在单用户的历史导入流程里出现。
 */
export class D1ChatStore implements ChatStore {
  private readonly db: D1DatabaseLike
  private readonly bucket: R2BucketLike

  constructor(db: D1DatabaseLike, bucket: R2BucketLike) {
    this.db = db
    this.bucket = bucket
  }

  private insertSessionFile(sessionId: string, fileId: string): D1PreparedStatementLike {
    return this.db
      .prepare('INSERT OR IGNORE INTO session_files (session_id, file_id) VALUES (?, ?)')
      .bind(sessionId, fileId)
  }

  private insertStagingSessionFile(sessionId: string, fileId: string): D1PreparedStatementLike {
    return this.db
      .prepare('INSERT OR IGNORE INTO staging_session_files (session_id, file_id) VALUES (?, ?)')
      .bind(sessionId, fileId)
  }

  /** 找出没有任何会话引用的附件行（字节在 R2，行在 D1）。 */
  private async orphanFileIds(): Promise<string[]> {
    const result = await this.db
      .prepare('SELECT id FROM files WHERE id NOT IN (SELECT file_id FROM session_files)')
      .all<{ id: string }>()
    return result.results.map((row) => row.id)
  }

  /** 删除附件：先删 R2 字节，再删 D1 行；中途失败最多留下无人引用的对象。 */
  private async dropFiles(ids: readonly string[]): Promise<void> {
    if (ids.length === 0) {
      return
    }
    await this.bucket.delete(ids.map(fileKey))
    for (const chunk of chunked(ids, MAX_IN_PARAMS)) {
      const placeholders = chunk.map(() => '?').join(', ')
      await this.db
        .prepare(`DELETE FROM files WHERE id IN (${placeholders})`)
        .bind(...chunk)
        .run()
    }
  }

  private async gcFiles(): Promise<void> {
    await this.dropFiles(await this.orphanFileIds())
  }

  async listSummaries(): Promise<SessionSummary[]> {
    const result = await this.db
      .prepare(
        'SELECT id, title, created_at AS createdAt, updated_at AS updatedAt FROM sessions ORDER BY updated_at DESC'
      )
      .all<SessionSummary>()
    return result.results
  }

  async readSession(id: string): Promise<string | null> {
    const row = await this.db
      .prepare('SELECT data FROM sessions WHERE id = ?')
      .bind(id)
      .first<{ data: string }>()
    return row?.data ?? null
  }

  async writeSession(session: SessionInput): Promise<void> {
    // 会话行、旧引用、新引用在同一个 batch 里落地；引用超过 batch 上限时
    // 只剩「追加引用」分批，会话本身与它的第一批引用仍是原子的。
    const head: D1PreparedStatementLike[] = [
      this.db
        .prepare(UPSERT_SESSION)
        .bind(session.id, session.title, session.createdAt, session.updatedAt, session.json),
      this.db.prepare('DELETE FROM session_files WHERE session_id = ?').bind(session.id),
    ]
    const room = MAX_BATCH_STATEMENTS - head.length
    for (const fileId of session.fileIds.slice(0, room)) {
      head.push(this.insertSessionFile(session.id, fileId))
    }
    await this.db.batch(head)
    for (const chunk of chunked(session.fileIds.slice(room), MAX_IN_PARAMS)) {
      await this.db.batch(chunk.map((fileId) => this.insertSessionFile(session.id, fileId)))
    }
  }

  async renameSession(id: string, title: string): Promise<boolean> {
    // 列表列与正文 JSON 一起改，一条语句原子完成，避免读改写
    const result = await this.db
      .prepare("UPDATE sessions SET title = ?, data = json_set(data, '$.title', ?) WHERE id = ?")
      .bind(title, title, id)
      .run()
    return result.meta.changes > 0
  }

  async deleteSession(id: string): Promise<void> {
    await this.db.batch([
      this.db.prepare('DELETE FROM sessions WHERE id = ?').bind(id),
      this.db.prepare('DELETE FROM session_files WHERE session_id = ?').bind(id),
    ])
    await this.gcFiles()
  }

  async writeFile(file: FileInput): Promise<void> {
    // 先写字节再写元数据：D1 行存在时对应的对象一定已经在 R2
    await this.bucket.put(fileKey(file.id), file.data, {
      httpMetadata: { contentType: file.mimeType },
    })
    await this.db.prepare(UPSERT_FILE).bind(file.id, file.mimeType, file.size).run()
  }

  async readFile(id: string): Promise<StoredFileBody | null> {
    const object = await this.bucket.get(fileKey(id))
    if (object === null) {
      return null
    }
    return {
      mimeType: object.httpMetadata?.contentType ?? '',
      size: object.size,
      body: object.body,
    }
  }

  async writeStagingSession(session: SessionInput): Promise<void> {
    const head: D1PreparedStatementLike[] = [
      this.db
        .prepare(UPSERT_STAGING_SESSION)
        .bind(session.id, session.title, session.createdAt, session.updatedAt, session.json),
      this.db.prepare('DELETE FROM staging_session_files WHERE session_id = ?').bind(session.id),
    ]
    const room = MAX_BATCH_STATEMENTS - head.length
    for (const fileId of session.fileIds.slice(0, room)) {
      head.push(this.insertStagingSessionFile(session.id, fileId))
    }
    await this.db.batch(head)
    for (const chunk of chunked(session.fileIds.slice(room), MAX_IN_PARAMS)) {
      await this.db.batch(chunk.map((fileId) => this.insertStagingSessionFile(session.id, fileId)))
    }
  }

  async writeStagingFile(file: FileInput): Promise<void> {
    await this.bucket.put(fileKey(file.id), file.data, {
      httpMetadata: { contentType: file.mimeType },
    })
    await this.db.prepare(UPSERT_STAGING_FILE).bind(file.id, file.mimeType, file.size).run()
  }

  async updateStagingFileTypes(types: ReadonlyMap<string, string>): Promise<void> {
    if (types.size === 0) {
      return
    }
    const result = await this.db
      .prepare('SELECT id, data FROM staging_sessions')
      .all<{ id: string; data: string }>()
    const updates: D1PreparedStatementLike[] = []
    for (const row of result.results) {
      const updated = retypeSessionJson(row.data, types)
      if (updated !== null) {
        updates.push(
          this.db.prepare('UPDATE staging_sessions SET data = ? WHERE id = ?').bind(updated, row.id)
        )
      }
    }
    for (const chunk of chunked(updates, MAX_BATCH_STATEMENTS)) {
      await this.db.batch(chunk)
    }
  }

  async clearStaging(): Promise<void> {
    const result = await this.db.prepare('SELECT id FROM staging_files').all<{ id: string }>()
    await this.db.batch([
      this.db.prepare('DELETE FROM staging_session_files'),
      this.db.prepare('DELETE FROM staging_sessions'),
      this.db.prepare('DELETE FROM staging_files'),
    ])
    // 暂存附件与正式附件同 key，清空暂存时它们一定是刚上传、还没被引用
    await this.bucket.delete(result.results.map((row) => fileKey(row.id)))
  }

  /**
   * 用暂存内容整体替换正式数据。附件字节在 R2、key 与暂存共用，
   * 所以这里只需要搬引用关系；被替换掉的旧附件随后从 R2 删除。
   */
  async commitStaging(): Promise<SessionSummary[]> {
    const summaries = await this.db
      .prepare(
        'SELECT id, title, created_at AS createdAt, updated_at AS updatedAt FROM staging_sessions ORDER BY updated_at DESC'
      )
      .all<SessionSummary>()
    const stale = await this.db
      .prepare('SELECT id FROM files WHERE id NOT IN (SELECT id FROM staging_files)')
      .all<{ id: string }>()
    await this.db.batch([
      this.db.prepare('DELETE FROM session_files'),
      this.db.prepare('DELETE FROM sessions'),
      this.db.prepare('DELETE FROM files'),
      this.db.prepare(
        'INSERT INTO sessions (id, title, created_at, updated_at, data) SELECT id, title, created_at, updated_at, data FROM staging_sessions'
      ),
      this.db.prepare(
        'INSERT INTO session_files (session_id, file_id) SELECT session_id, file_id FROM staging_session_files'
      ),
      this.db.prepare(
        'INSERT INTO files (id, mime_type, size) SELECT id, mime_type, size FROM staging_files'
      ),
      this.db.prepare('DELETE FROM staging_session_files'),
      this.db.prepare('DELETE FROM staging_sessions'),
      this.db.prepare('DELETE FROM staging_files'),
    ])
    await this.bucket.delete(stale.results.map((row) => fileKey(row.id)))
    return summaries.results
  }

  async close(): Promise<void> {
    // D1 与 R2 由平台管理生命周期，没有需要释放的句柄
  }
}
