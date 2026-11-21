import { ApiError } from '../api/client.js'
import type { OpenAiChatRequest, OpenAiContentPart, OpenAiMessage } from '../api/openai.js'
import type { Provider } from '../providers.js'
import { resizeUploadImage } from '../../utils/resizeUploadImage.js'
import { getContextRounds, getReplyText } from './reply.js'
import type { FileAttachment, Message, UserMessage } from './types.js'

/**
 * 把会话转成 OpenAI 兼容协议的请求体。
 * 该协议没有 Files API、latest_reminder 角色、服务端工具与 assistant 预填充，
 * 所以只保留「文本 + 图片」：图片从本地原件读取（发送前已缩到长边 4096），编码成 data URL 内联。
 * 智能搜索由官方检索预取完成，结果以首条 system 消息注入。
 */

/** 一次请求内联图片的总字节上限；超出预算时优先保留最新的图片 */
const INLINE_BUDGET = 20 * 1024 * 1024

/** btoa 逐段处理，避免超长图片一次展开成参数字符串 */
const BASE64_CHUNK = 0x8000

const toBase64 = (bytes: Uint8Array): string => {
  let binary = ''
  for (let i = 0; i < bytes.length; i += BASE64_CHUNK) {
    binary += String.fromCharCode(...Array.from(bytes.subarray(i, i + BASE64_CHUNK)))
  }
  return btoa(binary)
}

/** 图片读本地原件，按上传时同一套规则缩放到长边上限后编码成 data URL */
const loadImagePart = async (
  file: FileAttachment,
  loadBlob: (id: string) => Promise<Blob | undefined>,
  signal: AbortSignal
): Promise<OpenAiContentPart | null> => {
  signal.throwIfAborted()
  const blob = await loadBlob(file.id).catch(() => undefined)
  if (!blob) {
    // 本地没有原件（导入的历史附件只有元数据），这张图不进入请求
    return null
  }
  const mimeType = file.mimeType || blob.type || 'image/png'
  const source = new File([blob], file.name, { type: mimeType })
  const resized = await resizeUploadImage(source, signal)
  signal.throwIfAborted()
  const bytes = new Uint8Array(await resized.arrayBuffer())
  const type = resized.type || mimeType
  return { type: 'image_url', image_url: { url: `data:${type};base64,${toBase64(bytes)}` } }
}

/** 文本与图片合成消息内容；纯文本时用字符串，兼容不认识内容块的旧端点 */
const toContent = (
  text: string,
  images: OpenAiContentPart[]
): string | OpenAiContentPart[] | null => {
  if (images.length === 0) {
    return text === '' ? null : text
  }
  return [...(text === '' ? [] : [{ type: 'text' as const, text }]), ...images]
}

export type OpenAiRequestContext = {
  history: Message[]
  question: UserMessage
  /** 官方检索结果的摘要；有值时作为首条 system 消息插入 */
  context?: string
}

/**
 * 构建请求体。当前提问里带文档（非图片）时直接报错：OpenAI 兼容协议无法随请求发送文档，
 * 静默丢掉会让用户以为已经送出；历史轮次里的文档则跳过，避免旧会话卡死。
 */
export const createOpenAiRequest = async (
  provider: Provider,
  { history, question, context }: OpenAiRequestContext,
  loadBlob: (id: string) => Promise<Blob | undefined>,
  signal: AbortSignal
): Promise<OpenAiChatRequest> => {
  if (question.files.some((file) => !file.isImage)) {
    throw new ApiError('protocol', { key: 'openAiDocumentUnsupported' })
  }

  let budget = INLINE_BUDGET
  const inlineImages = async (files: FileAttachment[]): Promise<OpenAiContentPart[]> => {
    const images: OpenAiContentPart[] = []
    for (const file of files) {
      if (!file.isImage) {
        continue
      }
      signal.throwIfAborted()
      if (file.size > budget) {
        continue
      }
      const image = await loadImagePart(file, loadBlob, signal)
      if (image) {
        budget -= file.size
        images.push(image)
      }
    }
    return images
  }

  // 预算从最新的内容开始分配，图片过多时先保住最近几轮
  const questionImages = await inlineImages(question.files)
  const rounds = getContextRounds(history)
  const historyImages = new Map<string, OpenAiContentPart[]>()
  for (let index = rounds.length - 1; index >= 0; index -= 1) {
    const [user] = rounds[index]
    historyImages.set(user.id, await inlineImages(user.files))
  }

  const messages: OpenAiMessage[] = []
  for (const [user, reply] of rounds) {
    const content = toContent(user.content, historyImages.get(user.id) ?? [])
    const answer = getReplyText(reply)
    if (content === null) {
      // 没有文字也没有可用图片的空轮次不进入上下文
      continue
    }
    messages.push({ role: 'user', content })
    if (answer !== '') {
      messages.push({ role: 'assistant', content: answer })
    }
  }
  // 检索结果放在最前面：端点看到的是一段「本轮可用资料」，历史轮次里不会重复出现
  if (context) {
    messages.unshift({ role: 'system', content: context })
  }
  messages.push({ role: 'user', content: toContent(question.content, questionImages) ?? '' })

  return {
    model: provider.model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
  }
}
