import { openAiBase } from '../providers.js'
import { ApiError, readErrorResponse, request } from './client.js'
import { readServerSentEvents } from './sse.js'
import type { MessageStreamEvent, MessageUsage, StopReason } from './types.js'

/**
 * OpenAI 兼容协议（POST /v1/chat/completions，stream: true）。
 * 这里只做两件事：拼请求、把 SSE 的增量翻译成应用内部的 MessageStreamEvent，
 * 会话层与消息渲染因此不必区分提供商用的是哪种协议。
 */

export type OpenAiContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }

export type OpenAiMessage = {
  role: 'user' | 'assistant'
  content: string | OpenAiContentPart[]
}

export type OpenAiChatRequest = {
  model: string
  messages: OpenAiMessage[]
  stream: true
  stream_options: { include_usage: true }
}

/** 流里出现的用量；OpenAI 与多数兼容端点同名，缺字段时按 0 处理 */
type OpenAiUsage = {
  prompt_tokens?: number
  completion_tokens?: number
  prompt_tokens_details?: { cached_tokens?: number }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const asString = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined

/** 一帧里我们关心的部分：正文、思考、结束原因与用量 */
type OpenAiChunk = {
  id?: string
  model?: string
  content?: string
  reasoning?: string
  finishReason?: string
  usage?: OpenAiUsage
}

const readChunk = (value: unknown): OpenAiChunk | null => {
  if (!isRecord(value)) {
    return null
  }
  const choices = Array.isArray(value.choices) ? value.choices : []
  const choice = isRecord(choices[0]) ? choices[0] : null
  const delta = isRecord(choice?.delta) ? choice.delta : null
  const usage = isRecord(value.usage) ? (value.usage as OpenAiUsage) : undefined
  // 只带 usage 的尾包没有 choices，也要保留
  if (!choice && !usage) {
    return null
  }
  return {
    id: asString(value.id),
    model: asString(value.model),
    content: asString(delta?.content),
    // DeepSeek、vLLM 等用 reasoning_content；OpenRouter 等用 reasoning
    reasoning: asString(delta?.reasoning_content) ?? asString(delta?.reasoning),
    finishReason: asString(choice?.finish_reason),
    usage,
  }
}

/** 流里的错误帧：{"error":{"message":"..."}} */
const readErrorPayload = (value: unknown): string | null => {
  if (!isRecord(value) || !isRecord(value.error)) {
    return null
  }
  return asString(value.error.message) ?? null
}

const toUsage = (usage: OpenAiUsage): MessageUsage => ({
  input_tokens: typeof usage.prompt_tokens === 'number' ? usage.prompt_tokens : 0,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens:
    typeof usage.prompt_tokens_details?.cached_tokens === 'number'
      ? usage.prompt_tokens_details.cached_tokens
      : 0,
  output_tokens: typeof usage.completion_tokens === 'number' ? usage.completion_tokens : 0,
})

const FINISH_REASONS: Record<string, StopReason> = {
  stop: 'end_turn',
  length: 'max_tokens',
  tool_calls: 'tool_use',
  function_call: 'tool_use',
  content_filter: 'refusal',
}

const toStopReason = (reason: string): StopReason => FINISH_REASONS[reason] ?? 'end_turn'

const THINKING_BLOCK = { type: 'thinking', thinking: '', signature: '' } as const
const TEXT_BLOCK = { type: 'text', text: '' } as const

/**
 * POST /v1/chat/completions（stream: true），把 OpenAI 的 chunk 翻译成内部事件：
 * 首帧转成 message_start，delta.content 转成文本块，reasoning_content / reasoning 转成思考块，
 * finish_reason 转成 message_delta，末尾的 usage 尾包并入 message_delta，`[DONE]` 转成 message_stop。
 * 端点不发 `[DONE]` 也没关系：已经收到结束原因就按正常结束处理。
 */
export async function* streamOpenAiMessage(
  apiKey: string,
  baseUrl: string,
  body: OpenAiChatRequest,
  signal: AbortSignal
): AsyncGenerator<MessageStreamEvent> {
  const response = await request(`${openAiBase(baseUrl)}/chat/completions`, {
    method: 'POST',
    headers: {
      ...(apiKey === '' ? {} : { Authorization: `Bearer ${apiKey}` }),
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
    },
    body: JSON.stringify(body),
    signal,
  })
  const contentType = response.headers.get('Content-Type') ?? ''
  if (!response.body || !contentType.includes('text/event-stream')) {
    // 200 但不是流（部分网关把 stream 参数吞掉了），按协议错误展示响应体
    throw await readErrorResponse(response, 'protocol', '')
  }

  let started = false
  let blockIndex = -1
  let blockType: 'text' | 'thinking' | null = null
  let stopReason: StopReason | undefined

  for await (const { event: eventName, data: raw } of readServerSentEvents(response.body, signal)) {
    const data = raw.trim()
    if (data === '') {
      continue
    }
    if (data === '[DONE]') {
      break
    }
    let payload: unknown
    try {
      payload = JSON.parse(data)
    } catch {
      if (eventName === 'error') {
        throw new ApiError('stream', data)
      }
      continue
    }
    const message = readErrorPayload(payload)
    if (message !== null) {
      throw new ApiError('stream', message)
    }
    if (eventName === 'error') {
      throw new ApiError('stream', data)
    }
    const chunk = readChunk(payload)
    if (!chunk) {
      continue
    }
    if (!started) {
      started = true
      yield {
        type: 'message_start',
        message: {
          id: chunk.id ?? '',
          model: chunk.model ?? body.model,
          ...(chunk.usage ? { usage: toUsage(chunk.usage) } : {}),
        },
      }
    }
    if (chunk.reasoning) {
      if (blockType === 'text') {
        yield { type: 'content_block_stop', index: blockIndex }
        blockType = null
      }
      if (blockType !== 'thinking') {
        blockIndex += 1
        blockType = 'thinking'
        yield { type: 'content_block_start', index: blockIndex, content_block: THINKING_BLOCK }
      }
      yield {
        type: 'content_block_delta',
        index: blockIndex,
        delta: { type: 'thinking_delta', thinking: chunk.reasoning },
      }
    }
    if (chunk.content) {
      if (blockType === 'thinking') {
        yield { type: 'content_block_stop', index: blockIndex }
        blockType = null
      }
      if (blockType !== 'text') {
        blockIndex += 1
        blockType = 'text'
        yield { type: 'content_block_start', index: blockIndex, content_block: TEXT_BLOCK }
      }
      yield {
        type: 'content_block_delta',
        index: blockIndex,
        delta: { type: 'text_delta', text: chunk.content },
      }
    }
    if (chunk.finishReason) {
      if (blockType) {
        yield { type: 'content_block_stop', index: blockIndex }
        blockType = null
      }
      stopReason = toStopReason(chunk.finishReason)
      yield {
        type: 'message_delta',
        delta: { stop_reason: stopReason, stop_sequence: null },
        ...(chunk.usage ? { usage: toUsage(chunk.usage) } : {}),
      }
    } else if (chunk.usage && stopReason) {
      // include_usage 的尾包通常晚于 finish_reason，且 choices 为空
      yield {
        type: 'message_delta',
        delta: { stop_reason: stopReason, stop_sequence: null },
        usage: toUsage(chunk.usage),
      }
    }
  }

  if (blockType) {
    yield { type: 'content_block_stop', index: blockIndex }
  }
  if (!started) {
    // 空流：既没有首帧也没有错误帧，按断流处理
    throw new ApiError('interrupted', '')
  }
  yield { type: 'message_stop' }
}
