import { useState } from 'react'
import {
  defaultSystemPrompt,
  resolveSystemPrompt,
  updateProvider,
  type Provider,
} from '../../services/providers.js'
import { useTranslate } from '../../i18n/index.js'
import styles from './Settings.module.css'

/** 单条提示词的长度上限：够写几段人设，又不至于把每轮请求撑得太大 */
const MAX_CHARS = 4000

/**
 * 系统提示词：输入框里始终显示当前实际生效的内容，未自定义时就是默认值，失焦即保存。
 * 「清空」与「默认」分开存储：清空表示明确不发送 system，恢复默认则回到该提供商的默认值。
 */
export const SystemPromptField = ({ provider }: { provider: Provider }) => {
  const t = useTranslate()
  const [value, setValue] = useState(() => resolveSystemPrompt(provider))
  const fallback = defaultSystemPrompt(provider)
  const customized = provider.systemPrompt !== null

  const save = (next: string) => {
    const text = next.trim()
    // 与默认值完全一致时退回默认状态：以后默认文案调整，这里能跟着变
    if (text === fallback) {
      if (customized) {
        updateProvider(provider.id, { systemPrompt: null })
      }
      return
    }
    if (text === provider.systemPrompt) {
      return
    }
    updateProvider(provider.id, { systemPrompt: text })
  }

  const reset = () => {
    setValue(fallback)
    updateProvider(provider.id, { systemPrompt: null })
  }

  return (
    <div className={styles.providerField}>
      <div className={styles.providerFieldHeader}>
        <div className={styles.label}>{t('providerSystemPromptLabel')}</div>
        <span className={styles.providerTag}>
          {t(customized ? 'providerSystemPromptCustom' : 'providerSystemPromptDefault')}
        </span>
        <button
          type="button"
          className={styles.providerResetButton}
          disabled={!customized}
          onClick={reset}
        >
          {t('providerSystemPromptReset')}
        </button>
      </div>
      <textarea
        className={styles.providerTextarea}
        rows={4}
        maxLength={MAX_CHARS}
        value={value}
        placeholder={t('providerSystemPromptPlaceholder')}
        spellCheck={false}
        onChange={(event) => setValue(event.target.value)}
        onBlur={(event) => save(event.target.value)}
      />
      <div className={styles.description}>{t('providerSystemPromptHint')}</div>
    </div>
  )
}
