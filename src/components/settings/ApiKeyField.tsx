import { useState } from 'react'
import { IconEditOutline16 } from '../base/icons.js'
import { useIsMobile } from '../../app/viewport.js'
import { IconButton } from '../base/IconButton.js'
import { verifyApiKey } from '../../services/api/client.js'
import { isValidBaseUrl, setProviderApiKey, type Provider } from '../../services/providers.js'
import { useTranslate } from '../../i18n/index.js'
import { useApiKeyForm } from './useApiKeyForm.js'
import styles from './Settings.module.css'

/**
 * API Key：保存后只显示掩码，点编辑按钮才能重新输入。
 * 内置 DeepSeek 必须有 Key；自定义端点可留空表示无需鉴权。
 */
export const ApiKeyField = ({ provider }: { provider: Provider }) => {
  const t = useTranslate()
  const isMobile = useIsMobile()
  const [editing, setEditing] = useState(false)
  // 键盘校验需要一个可用的地址；地址还没填好时先提示，不让用户白等一次失败
  const addressReady = isValidBaseUrl(provider.baseUrl)
  const form = useApiKeyForm({
    verify: (apiKey) => verifyApiKey(provider.baseUrl, apiKey, provider.model, provider.protocol),
    save: (apiKey) => setProviderApiKey(provider.id, apiKey),
    ready: addressReady,
    onSaved: () => setEditing(false),
  })
  const apiKey = provider.apiKey
  const showInput = apiKey === '' || editing

  return (
    <div className={styles.cell}>
      <div className={styles.apiKey}>
        <div className={styles.label}>
          {provider.builtin ? t('apiKeyStart') : t('providerApiKeyLabel')}
        </div>
        {apiKey !== '' && !editing ? (
          <div className={styles.apiKeySaved}>
            <span className={styles.apiKeyMask}>{'*'.repeat(apiKey.length)}</span>
            <IconButton
              tone="primary"
              icon={<IconEditOutline16 />}
              tooltip={t('apiKeyEdit')}
              onClick={() => setEditing(true)}
            />
          </div>
        ) : (
          <div className={styles.apiKeyInput}>
            <input
              type="password"
              placeholder={
                provider.builtin ? t('apiKeyPlaceholder') : t('providerApiKeyPlaceholder')
              }
              autoComplete="off"
              spellCheck={false}
              // 移动端打开设置时不弹键盘，点编辑后才聚焦
              autoFocus={!isMobile || editing}
              value={form.value}
              onChange={(event) => form.setValue(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                  void form.submit()
                }
              }}
              onBlur={() => {
                // 修改时没输入就离开，回到已保存的状态
                if (apiKey !== '' && form.value.trim() === '') {
                  setEditing(false)
                }
              }}
            />
            {!isMobile && form.value.trim() !== '' && addressReady ? (
              <>
                <span className={styles.divider} />
                <button
                  type="button"
                  className={styles.confirm}
                  disabled={form.verifying}
                  // 保持输入框焦点
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => void form.submit()}
                >
                  {form.verifying ? t('apiKeyVerifying') : t('confirm')}
                </button>
              </>
            ) : null}
          </div>
        )}
        {provider.builtin ? null : (
          <div className={styles.description}>
            {addressReady ? t('providerApiKeyOptional') : t('providerBaseUrlFirst')}
          </div>
        )}
        {showInput && form.error ? <div className={styles.error}>{form.error}</div> : null}
      </div>
      {isMobile && showInput && form.value.trim() !== '' && addressReady ? (
        <button
          type="button"
          className={styles.mobileConfirm}
          disabled={form.verifying}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => void form.submit()}
        >
          {form.verifying ? t('apiKeyVerifying') : t('confirm')}
        </button>
      ) : null}
    </div>
  )
}
