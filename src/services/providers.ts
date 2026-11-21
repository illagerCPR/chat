import { create } from 'zustand'
import { createId } from '../utils/id.js'

/**
 * 提供商是一套完整的 API 配置（地址、Key、模型与能力）。
 * 内置的 DeepSeek 不可删除，可改地址与模型（指向自建反代时仍算官方）。
 * 自定义提供商指向任何实现 DeepSeek 协议（Anthropic 兼容格式）的端点。
 */

/** 构建期注入的 API 地址，内置 DeepSeek 的默认值 */
const DEFAULT_BASE_URL = __API_ORIGIN__

/** 内置 DeepSeek 的固定 id；模型请求里记录的就是它 */
export const BUILTIN_PROVIDER_ID = 'deepseek'
/** 内置 DeepSeek 的默认模型 */
export const BUILTIN_MODEL = 'deepseek-flash'

/** 协议字段：目前只实现 DeepSeek 的 Anthropic 兼容接口，OpenAI 兼容为后续预留 */
export type ProviderProtocol = 'deepseek'

/** 端点实际支持的能力，界面据此显隐；聊天恒可用，不设开关 */
export type ProviderCapabilities = {
  /** 附件：图片与文档经 Anthropic Files API 上传 */
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
  /** 内置项不可删除，但允许改地址、Key 与模型 */
  builtin: boolean
  /** API 根地址，不含末尾斜杠；内置项默认取构建期 API_ORIGIN */
  baseUrl: string
  /** 空串表示未填写：内置项必须有 Key，自定义端点无需鉴权时可以留空 */
  apiKey: string
  /** 请求里的模型 id；自定义端点的模型名各不相同 */
  model: string
  protocol: ProviderProtocol
  capabilities: ProviderCapabilities
}

export type ProvidersState = {
  providers: Provider[]
  activeId: string
}

const STORAGE_KEY = 'chat-demo:providers'
/** 0.2.x 把 API Key 单独存在这个键，升级后迁移进内置提供商 */
const LEGACY_API_KEY = 'chat-demo:api-key'

const FULL_CAPABILITIES: ProviderCapabilities = {
  files: true,
  thinking: true,
  search: true,
  speech: true,
  balance: true,
}

/** 自定义端点默认只开附件与深度思考：余额、语音、联网搜索多为 DeepSeek 专有 */
const CUSTOM_CAPABILITIES: ProviderCapabilities = {
  files: true,
  thinking: true,
  search: false,
  speech: false,
  balance: false,
}

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
  return {
    id: value.id,
    name: value.name,
    // 内置标记只认 id，存档被改成可删除也不会生效
    builtin: value.id === BUILTIN_PROVIDER_ID,
    baseUrl: value.baseUrl,
    apiKey: typeof value.apiKey === 'string' ? value.apiKey : '',
    model: value.model,
    protocol: 'deepseek',
    capabilities: readCapabilities(value.capabilities),
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

const readState = (): ProvidersState => {
  const legacyKey = readStorage(LEGACY_API_KEY) ?? ''
  let providers: Provider[] = []
  let activeId: string | null = null
  try {
    const stored: unknown = JSON.parse(readStorage(STORAGE_KEY) ?? 'null')
    if (isRecord(stored) && Array.isArray(stored.providers)) {
      providers = stored.providers.flatMap((item) => readProvider(item) ?? [])
      activeId = typeof stored.activeId === 'string' ? stored.activeId : null
    }
  } catch {
    // 存档损坏时回到只有内置提供商的初始状态
  }
  providers = withBuiltin(providers, legacyKey)
  return {
    providers,
    activeId: providers.some((provider) => provider.id === activeId)
      ? (activeId as string)
      : providers[0].id,
  }
}

export const useProviders = create<ProvidersState>(readState)

const persist = () => {
  const { providers, activeId } = useProviders.getState()
  writeStorage(STORAGE_KEY, JSON.stringify({ providers, activeId }))
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

export const setActiveProvider = (id: string) => {
  if (useProviders.getState().providers.some((provider) => provider.id === id)) {
    commit({ activeId: id })
  }
}

type ProviderPatch = Partial<Omit<Provider, 'id' | 'builtin' | 'protocol'>>

export const updateProvider = (id: string, patch: ProviderPatch) => {
  commit({
    providers: useProviders
      .getState()
      .providers.map((provider) => (provider.id === id ? { ...provider, ...patch } : provider)),
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

/** 可以发起请求：地址有效，且内置项已填 Key（自定义端点允许无鉴权） */
export const isProviderReady = (provider: Provider): boolean =>
  isValidBaseUrl(provider.baseUrl) && (!provider.builtin || provider.apiKey !== '')
