import { HttpError } from './errors.ts'

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isTimestamp = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value)

/** 归档导入的 id 来自外部文件，只接受能安全放进 URL 与数据库键的片段。 */
const ID_PATTERN = /^[^/\\]{1,255}$/

const hasControlCharacter = (value: string): boolean => {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0
    if (code < 0x20 || code === 0x7f) {
      return true
    }
  }
  return false
}

export const parseId = (segment: string | undefined): string => {
  if (segment === undefined || segment === '') {
    throw new HttpError(400, 'Missing resource id')
  }
  let id: string
  try {
    id = decodeURIComponent(segment)
  } catch {
    throw new HttpError(400, 'Malformed resource id')
  }
  if (!ID_PATTERN.test(id) || id === '.' || id === '..' || hasControlCharacter(id)) {
    throw new HttpError(400, 'Invalid resource id')
  }
  return id
}

/**
 * 校验会话 JSON 的骨架：正文由前端与历史导入共同保证，
 * 这里只挡住会让数据库列或列表出现废数据的情况。
 */
export type SessionInput = {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  json: string
  fileIds: string[]
}

export const parseSessionInput = (value: unknown): SessionInput => {
  if (!isRecord(value)) {
    throw new HttpError(400, 'Session must be a JSON object')
  }
  const { id, title, createdAt, updatedAt, messages } = value
  if (typeof id !== 'string' || id === '') {
    throw new HttpError(400, 'Session id is missing')
  }
  if (typeof title !== 'string') {
    throw new HttpError(400, 'Session title must be a string')
  }
  if (!isTimestamp(createdAt) || !isTimestamp(updatedAt)) {
    throw new HttpError(400, 'Session timestamps must be finite numbers')
  }
  if (!Array.isArray(messages)) {
    throw new HttpError(400, 'Session messages must be an array')
  }
  const fileIds = new Set<string>()
  for (const message of messages) {
    if (!isRecord(message) || message.role !== 'user' || !Array.isArray(message.files)) {
      continue
    }
    for (const file of message.files) {
      if (isRecord(file) && typeof file.id === 'string' && file.id !== '') {
        fileIds.add(file.id)
      }
    }
  }
  return { id, title, createdAt, updatedAt, json: JSON.stringify(value), fileIds: [...fileIds] }
}

export const parseTitleUpdate = (value: unknown): string => {
  if (!isRecord(value) || typeof value.title !== 'string') {
    throw new HttpError(400, 'Rename request must contain a title string')
  }
  return value.title
}

export const parseFileTypesUpdate = (value: unknown): Map<string, string> => {
  if (!isRecord(value) || !isRecord(value.types)) {
    throw new HttpError(400, 'File type update must contain a types object')
  }
  const types = new Map<string, string>()
  for (const [id, type] of Object.entries(value.types)) {
    if (typeof type !== 'string') {
      throw new HttpError(400, `File type for ${id} must be a string`)
    }
    types.set(id, type)
  }
  return types
}

/** 会话正文里每处附件引用都换成本次识别出的 MIME；导入时补全图片类型用。 */
export const retypeSessionJson = (
  json: string,
  types: ReadonlyMap<string, string>
): string | null => {
  const session = JSON.parse(json) as unknown
  if (!isRecord(session) || !Array.isArray(session.messages)) {
    return null
  }
  let changed = false
  for (const message of session.messages) {
    if (!isRecord(message) || message.role !== 'user' || !Array.isArray(message.files)) {
      continue
    }
    for (const file of message.files) {
      if (!isRecord(file) || typeof file.id !== 'string') {
        continue
      }
      const type = types.get(file.id) ?? ''
      if (file.mimeType !== type) {
        file.mimeType = type
        changed = true
      }
    }
  }
  return changed ? JSON.stringify(session) : null
}

/** 用同样规则重命名正文里的标题，让列表列与 JSON 两个视图保持一致。 */
export const retitleSessionJson = (json: string, title: string): string | null => {
  const session = JSON.parse(json) as unknown
  if (!isRecord(session)) {
    return null
  }
  session.title = title
  return JSON.stringify(session)
}
