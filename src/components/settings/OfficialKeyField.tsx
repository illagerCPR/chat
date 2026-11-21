import { useState } from 'react'
import { IconEditOutline16 } from '../base/icons.js'
import { IconButton } from '../base/IconButton.js'
import { useIsMobile } from '../../app/viewport.js'
import { verifyApiKey } from '../../services/api/client.js'
import {
  BUILTIN_MODEL,
  OFFICIAL_BASE_URL,
  setOfficialApiKey,
  useProviders,
} from '../../services/providers.js'
import { useTranslate } from '../../i18n/index.js'
import { useApiKeyForm } from './useApiKeyForm.js'
import styles from './Settings.module.css'

/**
 * 官方能力 Key：联网搜索、语音与余额固定请求 DeepSeek 官方服务，
 * 与当前选中的提供商无关。留空表示沿用内置 DeepSeek 的 Key。
 */
export const OfficialKeyField = () => {
  const t = useTranslate()
  const isMobile = useIsMobile()
  const override = useProviders((state) => state.officialApiKey)
  const builtinKey = useProviders(
    (state) => state.providers.find((provider) => provider.builtin)?.apiKey ?? ''
  )
  const [editing, setEditing] = useState(false)
  const form = useApiKeyForm({
    verify: (apiKey) => verifyApiKey(OFFICIAL_BASE_URL, apiKey, BUILTIN_MODEL, 'deepseek'),
    save: setOfficialApiKey,
    ready: true,
    onSaved: () => setEditing(false),
  })
  const effective = override !== '' ? override : builtinKey
  const showInput = editing || effective === ''

  return (
    <div className={styles.cell}>
      <div className={styles.apiKey}>
        <div className={styles.label}>{t('officialKeyLabel')}</div>
        {showInput ? (
          <div className={styles.apiKeyInput}>
            <input
              type="password"
              placeholder={t('officialKeyPlaceholder')}
              autoComplete="off"
              spellCheck={false}
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
                if (effective !== '' && form.value.trim() === '') {
                  setEditing(false)
                }
              }}
            />
            {!isMobile && form.value.trim() !== '' ? (
              <>
                <span className={styles.divider} />
                <button
                  type="button"
                  className={styles.confirm}
                  disabled={form.verifying}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => void form.submit()}
                >
                  {form.verifying ? t('apiKeyVerifying') : t('confirm')}
                </button>
              </>
            ) : null}
          </div>
        ) : (
          <div className={styles.apiKeySaved}>
            {override !== '' ? (
              <>
                <span className={styles.apiKeyMask}>{'*'.repeat(override.length)}</span>
                <IconButton
                  tone="primary"
                  icon={<IconEditOutline16 />}
                  tooltip={t('apiKeyEdit')}
                  onClick={() => setEditing(true)}
                />
                <button
                  type="button"
                  className={styles.providerInlineButton}
                  onClick={() => setOfficialApiKey('')}
                >
                  {t('officialKeyReset')}
                </button>
              </>
            ) : (
              <button
                type="button"
                className={styles.providerInlineButton}
                onClick={() => setEditing(true)}
              >
                {t('apiKeyEdit')}
              </button>
            )}
          </div>
        )}
        <div className={styles.description}>
          {override !== ''
            ? t('officialKeyOverridden')
            : effective !== ''
              ? t('officialKeyInherited')
              : t('officialKeyMissing')}
        </div>
        <div className={styles.description}>{t('officialKeyHint')}</div>
        {showInput && form.error ? <div className={styles.error}>{form.error}</div> : null}
      </div>
      {isMobile && showInput && form.value.trim() !== '' ? (
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
