import { create } from 'zustand'
import { getBalance, type Balance, type BalanceInfo } from './api/balance.js'
import { getActiveProvider, getCapabilities } from './providers.js'

/**
 * 账户余额：页面打开时查一次，设置里可手动刷新，每次回复结束后静默更新。
 * 余额不会秒级变化，不做定时轮询。
 */
type BalanceState = {
  data: Balance | null
  /** 首次加载或手动刷新时为 true；静默刷新不改变它，避免界面闪烁 */
  loading: boolean
  error: unknown
}

export const useBalance = create<BalanceState>(() => ({ data: null, loading: false, error: null }))

/** 同一时间只保留最近一次请求，新的请求作废旧的 */
let controller: AbortController | null = null

const reset = () => {
  controller?.abort()
  controller = null
  useBalance.setState({ data: null, loading: false, error: null })
}

/**
 * 拉取余额。quiet 为 true 时不动 loading（回复结束后的静默更新），
 * 失败也不清掉已有数据，只是保留上一次读数。
 */
export const refreshBalance = async (quiet = false): Promise<void> => {
  const provider = getActiveProvider()
  // 余额是 DeepSeek 专有接口，自定义提供商未声明该能力、或没有 Key 时不查询
  if (!getCapabilities(provider).balance || provider.apiKey === '') {
    reset()
    return
  }
  controller?.abort()
  const current = new AbortController()
  controller = current
  if (!quiet) {
    useBalance.setState({ loading: true, error: null })
  }
  try {
    const data = await getBalance(provider.apiKey, current.signal)
    if (controller === current) {
      useBalance.setState({ data, loading: false, error: null })
    }
  } catch (error) {
    if (controller !== current) {
      return
    }
    controller = null
    useBalance.setState(quiet ? { loading: false } : { data: null, loading: false, error })
  }
}

const CURRENCY_SYMBOL: Record<string, string> = { CNY: '¥', USD: '$' }

/** CNY / USD 用符号，其余币种原样拼在后面 */
export const formatAmount = (currency: string, amount: string): string => {
  const symbol = CURRENCY_SYMBOL[currency]
  return symbol ? `${symbol}${amount}` : `${amount} ${currency}`
}

export const formatBalance = ({ currency, totalBalance }: BalanceInfo): string =>
  formatAmount(currency, totalBalance)

/** 多币种时用「 / 」连接，界面上只占一行 */
export const formatBalanceList = (balance: Balance): string =>
  balance.infos.length > 0 ? balance.infos.map(formatBalance).join(' / ') : ''
