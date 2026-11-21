import { streamMessage } from '../api/client.js'
import { streamOpenAiMessage } from '../api/openai.js'
import type { CreateMessageRequest } from '../api/types.js'
import { getProviderShape, type Provider } from '../providers.js'
import { applyEvent, getReplyText } from './reply.js'
import type { AssistantMessage } from './types.js'

/**
 * 对话标题：内置 DeepSeek 由服务端在主请求里生成（title 扩展字段），其余端点不认这个字段，
 * 所以在首轮回答结束后另发一次轻量请求，让当前提供商的模型概括主题。
 * 提示词只放在一条 user 消息里、不传思考与工具参数，尽量让严格校验的网关也能接受；
 * 失败由调用方静默处理，会话保持「未命名对话」，用户可随时手动重命名。
 */

/** 首问与回答各截断到这个长度：标题只需要主题，不需要全文 */
const MAX_INPUT_CHARS = 400
/** 提示词要求 20 字以内；模型偶尔超长时再按这个上限硬截 */
const MAX_TITLE_CHARS = 40
/** 标准 Anthropic 接口必填的输出上限，标题远用不到这么多 */
const TITLE_MAX_TOKENS = 128

const clip = (text: string): string => {
  const trimmed = text.trim()
  return trimmed.length > MAX_INPUT_CHARS ? `${trimmed.slice(0, MAX_INPUT_CHARS)}…` : trimmed
}

const createPrompt = (question: string, answer: string): string =>
  [
    '请为下面这段对话起一个标题。',
    '要求：不超过 20 个字，概括对话主题，使用对话的主要语言；',
    '只输出标题本身，不要引号、不要句号、不要任何解释。',
    '',
    `用户：${clip(question)}`,
    ...(answer === '' ? [] : [`助手：${clip(answer)}`]),
  ].join('\n')

/** 模型有时会带「标题：」前缀、引号或换行；统一裁掉，超长时截断 */
const cleanTitle = (raw: string): string => {
  const line =
    raw
      .split('\n')
      .map((item) => item.trim())
      .find((item) => item !== '') ?? ''
  const title = line
    .replace(/^(?:标题|题目|名称|title)\s*[:：]\s*/i, '')
    .replace(/^[>#*\s]+/, '')
    .trim()
    .replace(/^[「『“”"'《]+|[」』“”"'》]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return title.length > MAX_TITLE_CHARS ? `${title.slice(0, MAX_TITLE_CHARS)}…` : title
}

/** 事件合并用的空回复：只要正文，思考与工具块都丢弃 */
const createScratch = (provider: Provider): AssistantMessage => ({
  id: 'session-title',
  role: 'assistant',
  createdAt: 0,
  model: provider.model,
  providerId: provider.id,
  thinking: false,
  search: false,
  prefix: false,
  status: 'pending',
  blocks: [],
})

/**
 * 请求一次标题；返回空串表示模型没有给出可用内容。
 * 端点报错直接抛出，由调用方吞掉——起名失败不该打扰用户。
 */
export const requestSessionTitle = async (
  provider: Provider,
  question: string,
  answer: string,
  signal: AbortSignal
): Promise<string> => {
  const prompt = createPrompt(question, answer)
  const shape = getProviderShape(provider)
  const events =
    shape === 'openai'
      ? streamOpenAiMessage(
          provider.apiKey,
          provider.baseUrl,
          {
            model: provider.model,
            messages: [{ role: 'user', content: prompt }],
            stream: true,
            stream_options: { include_usage: true },
          },
          signal
        )
      : streamMessage(
          provider.baseUrl,
          provider.apiKey,
          {
            model: provider.model,
            // 标准 Anthropic 接口必填；DeepSeek 扩展接口不传
            ...(shape === 'anthropic' ? { max_tokens: TITLE_MAX_TOKENS } : {}),
            messages: [{ role: 'user', content: prompt }],
          } satisfies CreateMessageRequest,
          signal
        )
  const blockIndexes = new Map<number, number>()
  let reply = createScratch(provider)
  for await (const event of events) {
    reply = applyEvent(reply, event, Date.now(), blockIndexes)
  }
  return cleanTitle(getReplyText(reply))
}
