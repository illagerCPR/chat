import { useTranslate } from '../../i18n/index.js'
import { formatAmount, formatBalanceList, useBalance } from '../../services/balance.js'
import {
  getCapabilities,
  getOfficialApiKey,
  useActiveProvider,
  useOfficialKeyReady,
} from '../../services/providers.js'

export type BalanceStatus = {
  /** 已格式化数值，或「查询中 / 查询失败 / 余额不足」等状态文案 */
  text: string
  /** 失败或余额不足，界面上按错误色展示 */
  error: boolean
  /** text 是状态文案而非金额，设置页据此决定是否把它当成数值展示 */
  placeholder: boolean
  /** 赠金与充值明细；仅单币种时给出，多币种只展示合计 */
  detail?: string
}

/** 提供商不支持余额、或尚未填写 API Key 时返回 null，界面不渲染余额区域。 */
export const useBalanceStatus = (): BalanceStatus | null => {
  const t = useTranslate()
  const provider = useActiveProvider()
  // 余额走官方通道：官方 Key 变化时这一块要跟着重渲染
  useOfficialKeyReady()
  const data = useBalance((state) => state.data)
  const loading = useBalance((state) => state.loading)
  const error = useBalance((state) => state.error)

  if (!getCapabilities(provider).balance || getOfficialApiKey() === '') {
    return null
  }
  if (data) {
    const info = data.infos.length === 1 ? data.infos[0] : null
    return {
      text: data.isAvailable ? formatBalanceList(data) || '—' : t('balanceUnavailable'),
      error: !data.isAvailable,
      placeholder: false,
      detail: info
        ? t('balanceHint', {
            granted: formatAmount(info.currency, info.grantedBalance || '0'),
            toppedUp: formatAmount(info.currency, info.toppedUpBalance || '0'),
          })
        : undefined,
    }
  }
  if (error && !loading) {
    return { text: t('balanceFailed'), error: true, placeholder: true }
  }
  return { text: t('balanceLoading'), error: false, placeholder: true }
}
