import { translate, type TranslationMessage } from '../../i18n/index.js'
import {
  chatUrl,
  getActiveProvider,
  getProviderShape,
  modelsUrl,
  resolveEndpoint,
  type ProviderProtocol,
} from '../providers.js'
import { resizeUploadImage } from '../../utils/resizeUploadImage.js'
import { readMessageEvent } from './parseEvent.js'
import { readServerSentEvents } from './sse.js'
import type {
  ApiErrorBody,
  CreateMessageRequest,
  FileObject,
  FilePurpose,
  MessageStreamEvent,
} from './types.js'

/** 当前提供商按地址解析后的请求地址；形态决定扩展字段与附件方式 */
const endpoint = () => resolveEndpoint(getActiveProvider().baseUrl)
/** 上传类接口只在 DeepSeek 形态使用，等价的布尔判断收在一处 */
const activeShape = (): 'deepseek' | 'anthropic' =>
  getProviderShape(getActiveProvider()) === 'anthropic' ? 'anthropic' : 'deepseek'
/** 引用 Files API 上传的图片、调用 Anthropic 兼容 Files API 时必须携带 */
const FILES_BETA = 'files-api-2025-04-14'
/** 标准 Anthropic 接口要求携带的 API 版本头 */
const ANTHROPIC_VERSION = '2023-06-01'

export type ApiErrorKind =
  /** 非 2xx 响应 */
  | 'http'
  /** 流中返回的错误帧（如等待生成超时），随后连接关闭 */
  | 'stream'
  /** 请求没有到达服务端（断网、跨域被拦截等） */
  | 'network'
  /** 流在 message_stop 之前结束 */
  | 'interrupted'
  /** 响应不符合协议（如非 SSE 响应） */
  | 'protocol'

export class ApiError extends Error {
  readonly localMessage?: TranslationMessage

  constructor(
    readonly kind: ApiErrorKind,
    message: string | TranslationMessage,
    readonly status?: number
  ) {
    super(typeof message === 'string' ? message : translate(message.key, message.params))
    this.name = 'ApiError'
    this.localMessage = typeof message === 'string' ? undefined : message
  }
}

const isErrorBody = (value: unknown): value is ApiErrorBody =>
  typeof value === 'object' &&
  value !== null &&
  'error' in value &&
  typeof (value as ApiErrorBody).error?.message === 'string'

/** 读出非 2xx（或 200 但内容不是流）的响应体；错误体结构与 Anthropic、OpenAI 都一致 */
export const readErrorResponse = async (
  response: Response,
  kind: 'http' | 'protocol' = 'http',
  fallback = response.statusText
): Promise<ApiError> => {
  const text = await response.text().catch(() => '')
  let message = text || fallback
  try {
    const body: unknown = JSON.parse(text)
    if (isErrorBody(body)) {
      message = body.error.message
    }
  } catch {
    // 非 JSON 响应体直接展示原文
  }
  return new ApiError(kind, message, response.status)
}

export const request = async (url: string, init: RequestInit): Promise<Response> => {
  let response: Response
  try {
    response = await fetch(url, init)
  } catch (error) {
    if (init.signal?.aborted) {
      throw error
    }
    throw new ApiError('network', error instanceof Error ? error.message : String(error))
  }
  if (!response.ok) {
    throw await readErrorResponse(response)
  }
  return response
}

/** 无鉴权端点允许 Key 为空，此时不发送任何鉴权头 */
const bearerHeaders = (apiKey: string): Record<string, string> =>
  apiKey === '' ? {} : { Authorization: `Bearer ${apiKey}` }

/** 标准 Anthropic 网关的鉴权头：有的只认 x-api-key、有的只认 Bearer，两种都发 */
const standardAnthropicHeaders = (apiKey: string): Record<string, string> => ({
  ...(apiKey === '' ? {} : { 'x-api-key': apiKey, Authorization: `Bearer ${apiKey}` }),
  'anthropic-version': ANTHROPIC_VERSION,
})

/** 查模型列表用的头：标准 Anthropic 形态与聊天接口一致，其余只发 Bearer */
export const modelHeaders = (
  apiKey: string,
  shape: 'deepseek' | 'anthropic' | 'openai'
): Record<string, string> =>
  shape === 'anthropic' ? standardAnthropicHeaders(apiKey) : bearerHeaders(apiKey)

/**
 * Anthropic 格式的鉴权头，按端点形态选择：
 * - DeepSeek 形态沿用 x-api-key，带 Files API 时再加 anthropic-beta；
 * - 标准 Anthropic 形态按规范带 anthropic-version，鉴权头两种都发。
 */
const anthropicHeaders = (
  shape: 'deepseek' | 'anthropic',
  apiKey: string,
  beta: boolean
): Record<string, string> => {
  if (shape === 'anthropic') {
    return standardAnthropicHeaders(apiKey)
  }
  return {
    ...(apiKey === '' ? {} : { 'x-api-key': apiKey }),
    // Files API 和通过 file_id 引用图片时必传；纯文本聊天无需携带。
    ...(beta ? { 'anthropic-beta': FILES_BETA } : {}),
  }
}

/**
 * 用 GET /models 校验 API Key（不产生费用）。
 * baseUrl 与协议由调用方给出，用于校验尚未保存的提供商；OpenAI 兼容端点需要补 /v1。
 * 标准 Anthropic 形态的网关未必实现 /models：遇到 404/405 时改用一次极短的 /messages 请求确认鉴权。
 */
export const verifyApiKey = async (
  baseUrl: string,
  apiKey: string,
  model: string,
  protocol: ProviderProtocol,
  signal?: AbortSignal
): Promise<void> => {
  const resolved = resolveEndpoint(baseUrl)
  // 标准 Anthropic 网关的 /models 同样要 anthropic-version 与 x-api-key，不能只发 Bearer
  const shape = protocol === 'openai' ? 'openai' : resolved.shape
  try {
    await request(modelsUrl(baseUrl, protocol), {
      method: 'GET',
      headers: modelHeaders(apiKey, shape),
      signal,
    })
    return
  } catch (error) {
    const missingModels =
      error instanceof ApiError &&
      (error.status === 404 || error.status === 405) &&
      protocol === 'deepseek' &&
      resolved.shape === 'anthropic'
    if (!missingModels) {
      throw error
    }
  }
  try {
    await request(resolved.messages, {
      method: 'POST',
      headers: { ...standardAnthropicHeaders(apiKey), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        max_tokens: 16,
        messages: [{ role: 'user', content: 'ping' }],
      }),
      signal,
    })
  } catch (error) {
    // 400/422 说明 Key 已被接受、只是请求参数或模型不合规；429 是限流。这些不当作 Key 无效
    const accepted =
      error instanceof ApiError &&
      (error.status === 400 || error.status === 422 || error.status === 429)
    if (!accepted) {
      throw error
    }
  }
}

/**
 * POST /anthropic/v1/files 上传附件（不设过期时间，会话里的历史附件一直可用）。
 * purpose 为 null 时不传该字段（图片）；purpose 必须排在 file 之前。
 */
export const uploadFile = async (
  apiKey: string,
  file: File,
  purpose: FilePurpose | null,
  signal?: AbortSignal
): Promise<FileObject> => {
  const form = new FormData()
  if (purpose) {
    form.append('purpose', purpose)
  }
  form.append('file', purpose === null ? await resizeUploadImage(file, signal) : file)
  const response = await request(endpoint().files, {
    method: 'POST',
    headers: anthropicHeaders(activeShape(), apiKey, true),
    body: form,
    signal,
  })
  return (await response.json()) as FileObject
}

/** DELETE /anthropic/v1/files/{file_id} */
export const deleteFile = async (apiKey: string, fileId: string): Promise<void> => {
  await request(`${endpoint().files}/${encodeURIComponent(fileId)}`, {
    method: 'DELETE',
    headers: anthropicHeaders(activeShape(), apiKey, true),
  })
}

const hasFile = (body: CreateMessageRequest) =>
  body.messages.some(
    (message) =>
      typeof message.content !== 'string' &&
      message.content.some((block) => block.type === 'image' || block.type === 'document')
  )

/**
 * POST /anthropic/v1/messages（stream: true），逐个产出流式事件，收到 message_stop 时结束。
 * ping、保活注释与无法解析的内容不产出；中止请求时抛出 signal 的 AbortError。
 */
export async function* streamMessage(
  baseUrl: string,
  apiKey: string,
  body: CreateMessageRequest,
  signal: AbortSignal
): AsyncGenerator<MessageStreamEvent> {
  const resolved = resolveEndpoint(baseUrl)
  const response = await request(chatUrl(baseUrl, 'deepseek'), {
    method: 'POST',
    headers: {
      ...anthropicHeaders(resolved.shape, apiKey, hasFile(body)),
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
    },
    body: JSON.stringify({ ...body, stream: true }),
    signal,
  })
  const contentType = response.headers.get('Content-Type') ?? ''
  if (!response.body || !contentType.includes('text/event-stream')) {
    throw await readErrorResponse(response, 'protocol', '')
  }
  for await (const { event: eventName, data } of readServerSentEvents(response.body, signal)) {
    let payload: unknown
    try {
      payload = JSON.parse(data)
    } catch {
      if (eventName !== 'error') {
        continue
      }
    }
    if (isErrorBody(payload)) {
      throw new ApiError('stream', payload.error.message)
    }
    if (eventName === 'error') {
      throw new ApiError('stream', data)
    }
    const event = readMessageEvent(payload)
    if (!event) {
      continue
    }
    yield event
    if (event.type === 'message_stop') {
      return
    }
  }
  // 服务端没有提供错误内容时保持为空，不推测断流原因。
  throw new ApiError('interrupted', '')
}
