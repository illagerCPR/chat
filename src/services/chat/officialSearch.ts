import type { TranslationMessage } from '../../i18n/index.js'
import { streamMessage } from '../api/client.js'
import type { CreateMessageRequest } from '../api/types.js'
import {
  BUILTIN_MODEL,
  BUILTIN_PROVIDER_ID,
  OFFICIAL_BASE_URL,
  getOfficialApiKey,
} from '../providers.js'
import { applyEvent } from './reply.js'
import type { AssistantMessage, ReplyBlock } from './types.js'

/**
 * 第三方端点（标准 Anthropic 与 OpenAI 兼容）上的联网搜索：搜索工具只存在于 DeepSeek 服务端，
 * 第三方端点无法调用，所以先用官方 Key 打一次官方检索，再把结果注入主请求
 * （Anthropic 形态注入 system 字段，OpenAI 形态注入首条 system 消息）。
 * 检索失败不影响主请求：调用方按「没搜到」继续，只弹一条轻提示。
 */

/** 带进上下文的来源条数与字符上限；超出部分只影响注入，不影响已展示的卡片 */
const MAX_SOURCES = 8
const MAX_CONTEXT_CHARS = 4000

const searchInstruction = (question: string) =>
  `请使用联网搜索检索下面的问题，不要凭记忆回答。用一两句话概括结论，并列出参考的网页。\n\n问题：${question}`

/** 事件合并用的空回复：只借用工具块，正文与思考都丢弃 */
const createScratch = (): AssistantMessage => ({
  id: 'official-search',
  role: 'assistant',
  createdAt: 0,
  model: BUILTIN_MODEL,
  providerId: BUILTIN_PROVIDER_ID,
  thinking: false,
  search: true,
  prefix: false,
  status: 'pending',
  blocks: [],
})

const isToolBlock = (block: ReplyBlock): boolean =>
  block.type === 'server_tool_use' ||
  block.type === 'web_search_tool_result' ||
  block.type === 'web_fetch_tool_result'

/** 把检索结果整理成可注入的文本：标题、链接与网页摘要 */
const buildContext = (blocks: ReplyBlock[]): string => {
  const lines: string[] = []
  for (const block of blocks) {
    if (block.type !== 'web_search_tool_result' || lines.length >= MAX_SOURCES) {
      continue
    }
    for (const item of block.content) {
      if (item.type !== 'web_search_result') {
        continue
      }
      lines.push(`- ${item.title}｜${item.url}\n  ${item.snippet}`)
      if (lines.length >= MAX_SOURCES) {
        break
      }
    }
  }
  if (lines.length === 0) {
    return ''
  }
  const text = `以下是刚检索到的网页（DeepSeek 联网搜索，本轮由官方服务完成）：\n${lines.join('\n')}`
  return text.length > MAX_CONTEXT_CHARS ? `${text.slice(0, MAX_CONTEXT_CHARS)}…` : text
}

export type OfficialSearchResult = {
  /** 挂到回复顶部的检索块，界面上照常渲染来源卡片 */
  blocks: ReplyBlock[]
  /** 注入主请求的检索摘要 */
  context: string
}

type NoticeListener = (notice: TranslationMessage) => void
const noticeListeners = new Set<NoticeListener>()

/** 检索失败等降级情况由界面弹轻提示；服务层只广播文案 key */
export const onOfficialSearchNotice = (listener: NoticeListener) => {
  noticeListeners.add(listener)
  return () => {
    noticeListeners.delete(listener)
  }
}

const notify = (notice: TranslationMessage) => {
  for (const listener of noticeListeners) {
    listener(notice)
  }
}

/**
 * 用官方 Key 执行一次检索。没有官方 Key、没有可检索的文字、或模型没有触发搜索时返回 null，
 * 调用方继续发送不带检索结果的主请求。
 */
export const runOfficialSearch = async (
  question: string,
  signal: AbortSignal
): Promise<OfficialSearchResult | null> => {
  const apiKey = getOfficialApiKey()
  if (apiKey === '' || question.trim() === '') {
    return null
  }
  const body: CreateMessageRequest = {
    model: BUILTIN_MODEL,
    messages: [{ role: 'user', content: searchInstruction(question) }],
    // 只要检索结果，不需要思考；安全审核与主请求保持一致
    thinking: { type: 'disabled' },
    safety_check: { level: 'high' },
    tools: [{ type: 'deepseek_web_search', name: 'deepseek_web_search' }],
  }
  let scratch = createScratch()
  const blockIndexes = new Map<number, number>()
  for await (const event of streamMessage(OFFICIAL_BASE_URL, apiKey, body, signal)) {
    scratch = applyEvent(scratch, event, Date.now(), blockIndexes)
  }
  const blocks = scratch.blocks.filter(isToolBlock)
  const context = buildContext(blocks)
  return blocks.length === 0 || context === '' ? null : { blocks, context }
}

/** 主请求照常发送，只是没有检索结果；给用户一条提示，避免误以为搜索生效 */
export const notifyOfficialSearchFailed = () => notify({ key: 'officialSearchFailed' })
