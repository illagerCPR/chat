import { ApiError, apiBase, request } from './client.js'

/**
 * GET /user/balance 查询账户余额。
 * 金额是服务端的字符串（可能带两位小数），不做数字转换，原样展示避免精度与本地化差异。
 * 该接口与 /models 一样返回 access-control-allow-origin，静态页面可直接跨域调用。
 */

export type BalanceInfo = {
  /** CNY 或 USD */
  currency: string
  /** 总可用余额，含赠金与充值 */
  totalBalance: string
  /** 未过期的赠金余额 */
  grantedBalance: string
  /** 充值余额 */
  toppedUpBalance: string
}

export type Balance = {
  /** 当前账户是否有余额可供 API 调用 */
  isAvailable: boolean
  /** 按币种排列，可能为空 */
  infos: BalanceInfo[]
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const readString = (value: unknown) => (typeof value === 'string' ? value : '')

/** 只取展示需要的字段；单个币种条目不合法时跳过，不影响其余条目。 */
const readBalanceInfo = (value: unknown): BalanceInfo | null => {
  if (!isRecord(value) || typeof value.currency !== 'string') {
    return null
  }
  const totalBalance = readString(value.total_balance)
  if (!totalBalance) {
    return null
  }
  return {
    currency: value.currency,
    totalBalance,
    grantedBalance: readString(value.granted_balance),
    toppedUpBalance: readString(value.topped_up_balance),
  }
}

const readBalance = (value: unknown): Balance | null => {
  if (!isRecord(value) || typeof value.is_available !== 'boolean') {
    return null
  }
  const infos = Array.isArray(value.balance_infos)
    ? value.balance_infos.flatMap((item) => {
        const info = readBalanceInfo(item)
        return info ? [info] : []
      })
    : []
  return { isAvailable: value.is_available, infos }
}

/** 查询余额；响应结构不符时按协议错误处理，调用方展示统一的失败文案。 */
export const getBalance = async (apiKey: string, signal?: AbortSignal): Promise<Balance> => {
  const response = await request(`${apiBase()}/user/balance`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${apiKey}` },
    signal,
  })
  const raw = await response.text()
  let body: unknown
  try {
    body = JSON.parse(raw)
  } catch {
    throw new ApiError('protocol', raw)
  }
  const balance = readBalance(body)
  if (!balance) {
    throw new ApiError('protocol', raw)
  }
  return balance
}
