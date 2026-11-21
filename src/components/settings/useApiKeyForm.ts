import { useState } from 'react'
import { ApiError, verifyApiKey } from '../../services/api/client.js'
import { classifyApiError } from '../../services/api/errors.js'
import { isValidBaseUrl, setProviderApiKey, type Provider } from '../../services/providers.js'
import { useTranslate } from '../../i18n/index.js'

/**
 * 输入 API Key 后先用该提供商地址的 GET /models 校验，通过才保存。
 * 留空表示端点无需鉴权（自定义提供商），此时跳过校验直接保存。
 */
export const useApiKeyForm = (provider: Provider, onSaved?: () => void) => {
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
    // 留空只表示「不修改」；地址不合法时先让用户填好地址再校验
    if (verifying || apiKey === '' || (apiKey !== '' && !isValidBaseUrl(provider.baseUrl))) {
      return
    }
    setVerifying(true)
    setFailure(null)
    try {
      await verifyApiKey(provider.baseUrl, apiKey, provider.protocol)
      setProviderApiKey(provider.id, apiKey)
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
