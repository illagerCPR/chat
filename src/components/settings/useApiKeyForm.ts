import { useState } from 'react'
import { ApiError } from '../../services/api/client.js'
import { classifyApiError } from '../../services/api/errors.js'
import { useTranslate } from '../../i18n/index.js'

/**
 * 候选 Key 的输入状态：校验方式由调用方给出（按提供商的 /models、或官方通道的地址），
 * 这里只管输入、校验中与失败文案。留空输入表示「不修改」。
 */
export type ApiKeySubmission = {
  verify: (apiKey: string) => Promise<void>
  save: (apiKey: string) => void
  /** 校验前是否已具备条件；自定义提供商要求地址合法 */
  ready: boolean
  onSaved?: () => void
}

export const useApiKeyForm = ({ verify, save, ready, onSaved }: ApiKeySubmission) => {
  const t = useTranslate()
  const [value, setValue] = useState('')
  const [verifying, setVerifying] = useState(false)
  const [failure, setFailure] = useState<{ cause: unknown } | null>(null)
  const cause = failure?.cause
  const error =
    failure === null
      ? null
      : classifyApiError(cause) === 'unauthorized'
        ? t('apiKeyInvalid')
        : classifyApiError(cause) === 'network'
          ? t('commonNetworkErrorToast')
          : t('apiKeyVerificationFailed', {
              message:
                cause instanceof ApiError && cause.localMessage
                  ? t(cause.localMessage.key, cause.localMessage.params)
                  : cause instanceof Error
                    ? cause.message
                    : String(cause),
            })

  const submit = async () => {
    const apiKey = value.trim()
    // 留空只表示「不修改」；条件不满足时先让用户把地址填好再校验
    if (verifying || apiKey === '' || !ready) {
      return
    }
    setVerifying(true)
    setFailure(null)
    try {
      await verify(apiKey)
      save(apiKey)
      setValue('')
      onSaved?.()
    } catch (e) {
      setFailure({ cause: e })
    } finally {
      setVerifying(false)
    }
  }

  return { value, setValue, verifying, error, submit }
}
