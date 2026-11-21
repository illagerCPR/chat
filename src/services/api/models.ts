import { modelsUrl, type Provider } from '../providers.js'
import { ApiError, request } from './client.js'

/**
 * GET /models 拉取模型列表。DeepSeek 与 OpenAI 兼容端点返回同一种结构：
 * `{ object: 'list', data: [{ id: '...' }, ...] }`，鉴权都用 Bearer。
 */
export const listModels = async (provider: Provider, signal?: AbortSignal): Promise<string[]> => {
  if (provider.baseUrl === '') {
    throw new ApiError('protocol', '')
  }
  const response = await request(modelsUrl(provider.baseUrl, provider.protocol), {
    method: 'GET',
    headers: provider.apiKey === '' ? {} : { Authorization: `Bearer ${provider.apiKey}` },
    signal,
  })
  const text = await response.text()
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    throw new ApiError('protocol', text)
  }
  const data =
    typeof body === 'object' && body !== null && Array.isArray((body as { data?: unknown }).data)
      ? ((body as { data: unknown[] }).data ?? [])
      : []
  const ids = new Set<string>()
  for (const item of data) {
    if (typeof item === 'object' && item !== null) {
      const id = (item as { id?: unknown }).id
      if (typeof id === 'string' && id !== '') {
        ids.add(id)
      }
    }
  }
  return [...ids].sort((a, b) => a.localeCompare(b))
}
