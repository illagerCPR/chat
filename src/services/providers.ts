import { create } from 'zustand'
import { createId } from '../utils/id.js'

/**
 * 提供商是一套完整的 API 配置（地址、Key、模型、协议与能力）。
 * 内置的 DeepSeek 不可删除，名称、地址、模型与协议固定，只能改 Key、系统提示词与能力。
 * 自定义提供商可以指向任何实现 DeepSeek 协议（Anthropic 兼容格式）或 OpenAI 兼容协议
 * （/v1/chat/completions）的端点。
 */

/** 构建期注入的 API 地址，内置 DeepSeek 的默认值 */
const DEFAULT_BASE_URL = __API_ORIGIN__

/** 内置 DeepSeek 的固定 id；模型请求里记录的就是它 */
export const BUILTIN_PROVIDER_ID = 'deepseek'
/** 内置 DeepSeek 的默认模型 */
export const BUILTIN_MODEL = 'deepseek-flash'

/**
 * 协议决定请求路径与请求体形状：
 * - deepseek：DeepSeek 的 Anthropic 兼容接口，支持附件、搜索、语音与余额；
 * - openai：/v1/chat/completions，只支持聊天与图片内联，其余能力由协议表限定。
 */
export type ProviderProtocol = 'deepseek' | 'openai'

/** 端点实际支持的能力，界面据此显隐；聊天恒可用，不设开关 */
export type ProviderCapabilities = {
  /** 附件：DeepSeek 经 Files API 上传；OpenAI 兼容协议改为图片内联 */
  files: boolean
  /** 深度思考 */
  thinking: boolean
  /** 联网搜索；关闭时不声明 server tools 与安全审核 */
  search: boolean
  /** 语音输入与朗读 */
  speech: boolean
  /** 账户余额查询 */
  balance: boolean
}

export type Provider = {
  /** 内置固定为 deepseek，自定义为 p- 前缀的随机 id */
  id: string
  name: string
  /** 内置项不可删除，名称、地址、模型与协议都固定，只能改 Key、系统提示词与能力 */
  builtin: boolean
  /** API 根地址，不含末尾斜杠；内置项固定为构建期 API_ORIGIN */
  baseUrl: string
  /** 空串表示未填写：内置项必须有 Key，自定义端点无需鉴权时可以留空 */
  apiKey: string
  /** 请求里的模型 id；自定义端点的模型名各不相同 */
  model: string
  protocol: ProviderProtocol
  capabilities: ProviderCapabilities
  /**
   * 系统提示词：null 表示用默认值（内置 DeepSeek 为身份说明，自定义端点为空），
   * 空串表示用户明确选择不发送 system。
   */
  systemPrompt: string | null
}

export type ProvidersState = {
  providers: Provider[]
  activeId: string
  /**
   * 联网搜索、语音与余额走的 DeepSeek 官方通道所用的 Key。
   * 空串表示沿用内置提供商自己的 Key；这三项能力始终请求官方地址，与当前提供商的地址无关。
   */
  officialApiKey: string
}

/**
 * 端点的实际形态，由协议与地址共同决定：
 * - deepseek：DeepSeek 的 Anthropic 兼容接口，收发扩展字段并走 Files API；
 * - anthropic：标准的 Anthropic Messages API（第三方网关多为这一种）；
 * - openai：/v1/chat/completions。
 */
export type ProviderShape = 'deepseek' | 'anthropic' | 'openai'

/** 解析后的请求地址：形态决定扩展字段、附件方式与模型列表位置 */
export type ResolvedEndpoint = {
  /** 聊天与附件接口的前缀，如 https://host/anthropic/v1 */
  base: string
  shape: 'deepseek' | 'anthropic'
  messages: string
  files: string
  /** 模型列表：DeepSeek 在站点根，Anthropic 兼容在版本前缀下 */
  models: string
}

/** 内置 DeepSeek 的系统提示词默认值；自定义端点默认为空，即请求里不带 system */
const BUILTIN_SYSTEM_PROMPT = '该助手为DeepSeek，由深度求索公司创造。'

/** 默认值按提供商区分：只有内置 DeepSeek 带身份说明 */
export const defaultSystemPrompt = (provider: Provider): string =>
  provider.builtin ? BUILTIN_SYSTEM_PROMPT : ''

/** 本轮实际发送的系统提示词；存档为 null 时取默认值，空串表示明确不发送 */
export const resolveSystemPrompt = (provider: Provider): string =>
  provider.systemPrompt ?? defaultSystemPrompt(provider)

const STORAGE_KEY = 'chat-demo:providers'
/** 存档结构版本：低于当前版本的存档在加载时做一次性迁移 */
const STORAGE_SCHEMA = 4
/** 0.3.3 打开 OpenAI 端点三项能力的存档版本；低于它的存档才做那次迁移 */
const SCHEMA_OPENAI_CAPABILITIES = 3
/** 0.2.x 把 API Key 单独存在这个键，升级后迁移进内置提供商 */
const LEGACY_API_KEY = 'chat-demo:api-key'

const FULL_CAPABILITIES: ProviderCapabilities = {
  files: true,
  thinking: true,
  search: true,
  speech: true,
  balance: true,
}

/**
 * 自定义端点默认只开附件与深度思考：联网搜索、语音与余额在 0.3.x 之前是 DeepSeek 专有，
 * 现在虽然走官方通道，仍按需勾选，避免给不认识 server tools 的端点多发字段。
 */
const CUSTOM_CAPABILITIES: ProviderCapabilities = {
  files: true,
  thinking: true,
  search: false,
  speech: false,
  balance: false,
}

/**
 * 各形态真正支持的能力：
 * - DeepSeek 形态按扩展接口全开；
 * - Anthropic 形态没有 Files API（附件置灰），搜索改由官方检索预取实现；
 * - OpenAI 兼容协议做聊天与图片内联，搜索同样改由官方检索预取实现。
 * 语音与余额始终走官方通道，第三方端点上的搜索也由官方服务完成，是否可用还取决于
 * 官方 Key 是否存在，见 isCapabilitySupported。
 */
const SHAPE_CAPABILITIES: Record<ProviderShape, ProviderCapabilities> = {
  deepseek: FULL_CAPABILITIES,
  anthropic: { files: false, thinking: true, search: true, speech: true, balance: true },
  openai: { files: true, thinking: true, search: true, speech: true, balance: true },
}

/**
 * 需要 DeepSeek 官方 Key 的能力：搜索（第三方端点的预取）、语音、余额。
 * 只有 DeepSeek 形态的搜索由端点自己执行（server tools），不需要官方 Key。
 */
const OFFICIAL_CAPABILITIES: (keyof ProviderCapabilities)[] = ['search', 'speech', 'balance']

const readStorage = (key: string) => {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

const writeStorage = (key: string, value: string) => {
  try {
    localStorage.setItem(key, value)
  } catch {
    // 存储不可用时只在内存中生效
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const readCapabilities = (value: unknown): ProviderCapabilities => {
  const record = isRecord(value) ? value : {}
  const flag = (key: keyof ProviderCapabilities) =>
    typeof record[key] === 'boolean' ? record[key] : false
  return {
    files: flag('files'),
    thinking: flag('thinking'),
    search: flag('search'),
    speech: flag('speech'),
    balance: flag('balance'),
  }
}

/** 逐条容错：字段不全的存档条目直接丢弃，避免一处损坏影响整个列表 */
const readProvider = (value: unknown): Provider | null => {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    value.id === '' ||
    typeof value.name !== 'string' ||
    typeof value.baseUrl !== 'string' ||
    typeof value.model !== 'string'
  ) {
    return null
  }
  const builtin = value.id === BUILTIN_PROVIDER_ID
  return {
    id: value.id,
    // 内置标记只认 id，存档被改成可删除也不会生效
    builtin,
    // 内置项的名称、地址与模型已锁定：旧版本改过的值在这里迁回默认，避免「改过却只读」的错位
    name: builtin ? 'DeepSeek' : value.name,
    baseUrl: builtin ? DEFAULT_BASE_URL : value.baseUrl,
    apiKey: typeof value.apiKey === 'string' ? value.apiKey : '',
    model: builtin ? BUILTIN_MODEL : value.model,
    // 0.3.0 的存档没有协议字段；内置项始终按 DeepSeek 协议
    protocol: builtin || value.protocol !== 'openai' ? 'deepseek' : 'openai',
    capabilities: readCapabilities(value.capabilities),
    // 0.4.0 之前的存档没有提示词字段：null 表示用默认值，与「明确清空」区分开
    systemPrompt: typeof value.systemPrompt === 'string' ? value.systemPrompt : null,
  }
}

const createBuiltin = (apiKey: string): Provider => ({
  id: BUILTIN_PROVIDER_ID,
  name: 'DeepSeek',
  builtin: true,
  baseUrl: DEFAULT_BASE_URL,
  apiKey,
  model: BUILTIN_MODEL,
  protocol: 'deepseek',
  capabilities: { ...FULL_CAPABILITIES },
  systemPrompt: null,
})

/** 保证列表里始终有内置项，并把升级前的 API Key 迁移进去 */
const withBuiltin = (providers: Provider[], legacyKey: string): Provider[] => {
  const builtin = providers.find((provider) => provider.builtin)
  if (!builtin) {
    return [createBuiltin(legacyKey), ...providers]
  }
  return builtin.apiKey === '' && legacyKey !== ''
    ? providers.map((provider) =>
        provider.builtin ? { ...provider, apiKey: legacyKey } : provider
      )
    : providers
}

/**
 * 0.3.2 及更早版本的 OpenAI 兼容端点不支持联网搜索、语音与余额：设置页把这三项置灰，
 * 存档里的 false 并不是用户的选择。升级到 0.3.3 时按协议一次性打开，用户之后再关掉不会复原。
 */
const migrateOpenAiCapabilities = (providers: Provider[]): Provider[] =>
  providers.map((provider) =>
    provider.protocol === 'openai'
      ? {
          ...provider,
          capabilities: {
            ...provider.capabilities,
            search: true,
            speech: true,
            balance: true,
          },
        }
      : provider
  )

const readState = (): ProvidersState => {
  const legacyKey = readStorage(LEGACY_API_KEY) ?? ''
  let providers: Provider[] = []
  let activeId: string | null = null
  let officialApiKey = ''
  let schema = 0
  try {
    const stored: unknown = JSON.parse(readStorage(STORAGE_KEY) ?? 'null')
    if (isRecord(stored) && Array.isArray(stored.providers)) {
      providers = stored.providers.flatMap((item) => readProvider(item) ?? [])
      activeId = typeof stored.activeId === 'string' ? stored.activeId : null
      officialApiKey = typeof stored.officialApiKey === 'string' ? stored.officialApiKey : ''
      schema = typeof stored.schema === 'number' ? stored.schema : 0
    }
  } catch {
    // 存档损坏时回到只有内置提供商的初始状态
  }
  if (schema < SCHEMA_OPENAI_CAPABILITIES) {
    providers = migrateOpenAiCapabilities(providers)
  }
  providers = withBuiltin(providers, legacyKey)
  return {
    providers,
    activeId: providers.some((provider) => provider.id === activeId)
      ? (activeId as string)
      : providers[0].id,
    officialApiKey: officialApiKey.trim(),
  }
}

export const useProviders = create<ProvidersState>(readState)

const persist = () => {
  const { providers, activeId, officialApiKey } = useProviders.getState()
  writeStorage(
    STORAGE_KEY,
    JSON.stringify({ schema: STORAGE_SCHEMA, providers, activeId, officialApiKey })
  )
}

const commit = (next: Partial<ProvidersState>) => {
  useProviders.setState(next)
  persist()
}

/** 内置项固定排在最前，其余按创建顺序 */
const sortProviders = (providers: Provider[]) => [
  ...providers.filter((provider) => provider.builtin),
  ...providers.filter((provider) => !provider.builtin),
]

export const getActiveProvider = (): Provider => {
  const { providers, activeId } = useProviders.getState()
  return providers.find((provider) => provider.id === activeId) ?? providers[0]
}

/** 组件订阅当前提供商；切换后立即重渲染 */
export const useActiveProvider = (): Provider =>
  useProviders(
    (state) =>
      state.providers.find((provider) => provider.id === state.activeId) ?? state.providers[0]
  )

/**
 * 按形态收窄后的能力：存档里的勾选值再与形态支持的能力取交集，
 * 需要官方 Key 的能力（第三方端点上的搜索、语音、余额）额外要求官方 Key 存在。
 */
export const getCapabilities = (provider: Provider): ProviderCapabilities => ({
  files: provider.capabilities.files && isCapabilitySupported(provider, 'files'),
  thinking: provider.capabilities.thinking && isCapabilitySupported(provider, 'thinking'),
  search: provider.capabilities.search && isCapabilitySupported(provider, 'search'),
  speech: provider.capabilities.speech && isCapabilitySupported(provider, 'speech'),
  balance: provider.capabilities.balance && isCapabilitySupported(provider, 'balance'),
})

/** 该提供商是否支持某项能力，设置页据此禁用勾选框 */
export const isCapabilitySupported = (
  provider: Provider,
  key: keyof ProviderCapabilities
): boolean => {
  const shape = getProviderShape(provider)
  if (!SHAPE_CAPABILITIES[shape][key]) {
    return false
  }
  // 附件与深度思考只受形态限制；搜索在 DeepSeek 形态走 server tools，由端点自行实现
  if (!OFFICIAL_CAPABILITIES.includes(key)) {
    return true
  }
  if (key === 'search' && shape === 'deepseek') {
    return true
  }
  return hasOfficialApiKey()
}

/** 当前提供商实际使用的形态；OpenAI 兼容协议不参与地址解析 */
export const getProviderShape = (provider: Provider): ProviderShape =>
  provider.protocol === 'openai' ? 'openai' : resolveEndpoint(provider.baseUrl).shape

/** 官方通道（搜索、语音、余额）的地址，不受当前提供商影响 */
export const OFFICIAL_BASE_URL = DEFAULT_BASE_URL

/** 官方通道实际使用的 Key：单独配置优先，否则沿用内置 DeepSeek 的 Key */
export const getOfficialApiKey = (): string => {
  const { providers, officialApiKey } = useProviders.getState()
  const builtinKey = providers.find((provider) => provider.builtin)?.apiKey ?? ''
  return officialApiKey !== '' ? officialApiKey : builtinKey
}

export const hasOfficialApiKey = (): boolean => getOfficialApiKey() !== ''

/** 组件订阅「官方 Key 是否可用」：能力勾选框与输入区的按钮要随它重渲染 */
export const useOfficialKeyReady = (): boolean =>
  useProviders((state) => {
    const builtinKey = state.providers.find((provider) => provider.builtin)?.apiKey ?? ''
    return state.officialApiKey !== '' || builtinKey !== ''
  })

export const setOfficialApiKey = (apiKey: string) => {
  commit({ officialApiKey: apiKey.trim() })
}

export const setActiveProvider = (id: string) => {
  if (useProviders.getState().providers.some((provider) => provider.id === id)) {
    commit({ activeId: id })
  }
}

type ProviderPatch = Partial<Omit<Provider, 'id' | 'builtin'>>

export const updateProvider = (id: string, patch: ProviderPatch) => {
  // 内置项的身份固定为官方 DeepSeek：名称、地址、模型与协议都不接受改动
  const next: ProviderPatch =
    id === BUILTIN_PROVIDER_ID
      ? {
          ...(patch.apiKey !== undefined ? { apiKey: patch.apiKey } : {}),
          // 系统提示词是用户自己的语气设定，内置项也允许改
          ...(patch.systemPrompt !== undefined ? { systemPrompt: patch.systemPrompt } : {}),
          ...(patch.capabilities !== undefined ? { capabilities: patch.capabilities } : {}),
        }
      : patch
  commit({
    providers: useProviders.getState().providers.map((provider) => {
      if (provider.id !== id) {
        return provider
      }
      const merged = { ...provider, ...next }
      // 从官方端点换成第三方端点：语音、余额与检索本来就走官方通道，默认打开，用户可再关掉
      if (
        next.capabilities === undefined &&
        getProviderShape(provider) === 'deepseek' &&
        getProviderShape(merged) !== 'deepseek'
      ) {
        return {
          ...merged,
          capabilities: { ...merged.capabilities, search: true, speech: true, balance: true },
        }
      }
      return merged
    }),
  })
}

export const setProviderApiKey = (id: string, apiKey: string) => {
  updateProvider(id, { apiKey })
}

/** 新建自定义提供商并立即选中；名字由调用方按当前语言提供 */
export const addProvider = (name: string): string => {
  const provider: Provider = {
    id: `p-${createId()}`,
    name,
    builtin: false,
    baseUrl: '',
    apiKey: '',
    model: BUILTIN_MODEL,
    protocol: 'deepseek',
    capabilities: { ...CUSTOM_CAPABILITIES },
    systemPrompt: null,
  }
  commit({
    providers: sortProviders([...useProviders.getState().providers, provider]),
    activeId: provider.id,
  })
  return provider.id
}

/** 内置项不可删除；删除当前项时回落到内置项 */
export const removeProvider = (id: string) => {
  const state = useProviders.getState()
  if (id === BUILTIN_PROVIDER_ID || !state.providers.some((provider) => provider.id === id)) {
    return
  }
  commit({
    providers: state.providers.filter((provider) => provider.id !== id),
    activeId: state.activeId === id ? BUILTIN_PROVIDER_ID : state.activeId,
  })
}

const trimTrailingSlashes = (value: string) => value.replace(/\/+$/, '')

/** 去掉协议与主机后多余的空格和末尾斜杠，拼路径时不会出现重复的 / */
export const normalizeBaseUrl = (value: string) => trimTrailingSlashes(value.trim())

/** 地址是否可用：必须是 http(s) 绝对地址 */
export const isValidBaseUrl = (value: string): boolean => {
  const normalized = normalizeBaseUrl(value)
  if (normalized === '') {
    return false
  }
  try {
    const url = new URL(normalized)
    return url.protocol === 'https:' || url.protocol === 'http:'
  } catch {
    return false
  }
}

/**
 * OpenAI 兼容接口的根地址。`https://x`、`https://x/v1`、`https://x/v1/chat/completions`
 * 三种常见填法都归一到 `https://x/v1`；已经带版本段（v1、v1beta 等）的路径不再重复追加。
 */
export const openAiBase = (baseUrl: string): string => {
  const base = normalizeBaseUrl(baseUrl).replace(/\/(?:chat\/)?completions$/i, '')
  if (base === '') {
    return ''
  }
  try {
    return /\/v\d+[a-z0-9]*$/i.test(new URL(base).pathname) ? base : `${base}/v1`
  } catch {
    return `${base}/v1`
  }
}

/**
 * 解析请求地址。可填站点根、带路径前缀的基地址，或直接粘贴整条端点：
 * - `https://api.deepseek.com`、`…/anthropic`、`…/anthropic/v1` → DeepSeek 形态，补全 `/anthropic/v1`；
 * - `https://gw.example.com/provider/v1/message(s)` → 去掉端点段，按 Anthropic 形态请求 `…/provider/v1/messages`；
 * - `…/provider/v1`、`…/provider` → Anthropic 形态，缺版本段时补 `/v1`。
 * 根地址仍按 DeepSeek 结构补全（与 0.3.1 之前一致），要标准 Anthropic 形态请明确写到 `/v1`。
 */
export const resolveEndpoint = (baseUrl: string): ResolvedEndpoint => {
  // 粘贴整条端点时先摘掉末段，避免拼成 …/messages/messages
  const cleaned = normalizeBaseUrl(baseUrl).replace(/\/(?:messages?)$/i, '')
  const empty: ResolvedEndpoint = {
    base: '',
    shape: 'deepseek',
    messages: '',
    files: '',
    models: '',
  }
  if (cleaned === '') {
    return empty
  }
  let url: URL
  try {
    url = new URL(cleaned)
  } catch {
    return empty
  }
  const origin = url.origin
  const path = url.pathname.replace(/\/+$/, '')
  // 带 /anthropic 段的地址视为 DeepSeek 形态；根地址同样保持 DeepSeek 结构
  const deepseek = path === '' || /\/(?:anthropic)(?:\/v\d+[a-z0-9]*)?$/i.test(path)
  const versioned = /\/v\d+[a-z0-9]*$/i.test(path)
  const base =
    path === '' ? `${origin}/anthropic/v1` : versioned ? `${origin}${path}` : `${origin}${path}/v1`
  return {
    base,
    shape: deepseek ? 'deepseek' : 'anthropic',
    messages: `${base}/messages`,
    files: `${base}/files`,
    models: deepseek ? `${origin}/models` : `${base}/models`,
  }
}

/** 拉取模型列表、校验 Key 的地址：两种协议的版本段规则不同 */
export const modelsUrl = (baseUrl: string, protocol: ProviderProtocol): string =>
  protocol === 'openai' ? `${openAiBase(baseUrl)}/models` : resolveEndpoint(baseUrl).models

/** 可以发起请求：地址有效，且内置项已填 Key（自定义端点允许无鉴权） */
export const isProviderReady = (provider: Provider): boolean =>
  isValidBaseUrl(provider.baseUrl) && (!provider.builtin || provider.apiKey !== '')
