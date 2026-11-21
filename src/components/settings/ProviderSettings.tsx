import { useState, type ReactNode } from 'react'
import clsx from 'clsx'
import { useTranslate, type TranslationKey } from '../../i18n/index.js'
import { IconTrashOutline16 } from '../base/icons.js'
import { IconButton } from '../base/IconButton.js'
import {
  addProvider,
  isValidBaseUrl,
  normalizeBaseUrl,
  removeProvider,
  setActiveProvider,
  updateProvider,
  useProviders,
  type Provider,
  type ProviderCapabilities,
} from '../../services/providers.js'
import { ApiKeyField } from './ApiKeyField.js'
import styles from './Settings.module.css'

const CAPABILITIES: { key: keyof ProviderCapabilities; label: TranslationKey }[] = [
  { key: 'files', label: 'providerCapFiles' },
  { key: 'thinking', label: 'providerCapThinking' },
  { key: 'search', label: 'providerCapSearch' },
  { key: 'speech', label: 'providerCapSpeech' },
  { key: 'balance', label: 'providerCapBalance' },
]

const Field = ({ label, children }: { label: string; children: ReactNode }) => (
  <div className={styles.providerField}>
    <div className={styles.label}>{label}</div>
    {children}
  </div>
)

const commitOnEnter = (event: React.KeyboardEvent<HTMLInputElement>) => {
  if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
    event.currentTarget.blur()
  }
}

/** 编辑器跟随当前选中的提供商，切换时整块重建，未提交的输入不会带到另一条配置上 */
const ProviderEditor = ({ provider }: { provider: Provider }) => {
  const t = useTranslate()
  const [name, setName] = useState(provider.name)
  const [baseUrl, setBaseUrl] = useState(provider.baseUrl)
  const [model, setModel] = useState(provider.model)
  const [urlError, setUrlError] = useState(false)

  const commitName = () => {
    const value = name.trim()
    if (value === '' || value === provider.name) {
      setName(provider.name)
      return
    }
    updateProvider(provider.id, { name: value })
  }

  const commitBaseUrl = () => {
    const value = normalizeBaseUrl(baseUrl)
    if (value === '') {
      // 新建的自定义提供商允许先留空；内置项必须有地址
      if (provider.builtin) {
        setUrlError(true)
        return
      }
      setUrlError(false)
      setBaseUrl('')
      updateProvider(provider.id, { baseUrl: '' })
      return
    }
    if (!isValidBaseUrl(value)) {
      setUrlError(true)
      return
    }
    setUrlError(false)
    setBaseUrl(value)
    if (value !== provider.baseUrl) {
      updateProvider(provider.id, { baseUrl: value })
    }
  }

  const commitModel = () => {
    const value = model.trim()
    if (value === '' || value === provider.model) {
      setModel(provider.model)
      return
    }
    updateProvider(provider.id, { model: value })
  }

  return (
    <div className={styles.providerEditor}>
      <Field label={t('providerNameLabel')}>
        <input
          className={styles.providerInput}
          value={name}
          spellCheck={false}
          onChange={(event) => setName(event.target.value)}
          onBlur={commitName}
          onKeyDown={commitOnEnter}
        />
      </Field>
      <Field label={t('providerBaseUrlLabel')}>
        <input
          className={clsx(styles.providerInput, urlError && styles.inputError)}
          value={baseUrl}
          placeholder={t('providerBaseUrlPlaceholder')}
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => setBaseUrl(event.target.value)}
          onBlur={commitBaseUrl}
          onKeyDown={commitOnEnter}
        />
      </Field>
      {urlError ? <div className={styles.error}>{t('providerBaseUrlInvalid')}</div> : null}
      <Field label={t('providerModelLabel')}>
        <input
          className={styles.providerInput}
          value={model}
          placeholder={t('providerModelPlaceholder')}
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => setModel(event.target.value)}
          onBlur={commitModel}
          onKeyDown={commitOnEnter}
        />
      </Field>
      <ApiKeyField provider={provider} />
      <div className={styles.providerField}>
        <div className={styles.label}>{t('providerCapabilitiesLabel')}</div>
        <div className={styles.providerCapabilityList}>
          {CAPABILITIES.map((item) => (
            <label key={item.key} className={styles.providerCapability}>
              <input
                type="checkbox"
                checked={provider.capabilities[item.key]}
                onChange={(event) =>
                  updateProvider(provider.id, {
                    capabilities: {
                      ...provider.capabilities,
                      [item.key]: event.target.checked,
                    },
                  })
                }
              />
              {t(item.label)}
            </label>
          ))}
        </div>
        <div className={styles.description}>{t('providerCapabilitiesHint')}</div>
      </div>
      <div className={styles.description}>{t('providerEndpointHint')}</div>
    </div>
  )
}

/**
 * 提供商设置：列表里选当前启用的一项，下方编辑它的地址、Key、模型与能力。
 * 内置 DeepSeek 不能删除，自定义提供商可以随时添加与删除。
 */
export const ProviderSettings = () => {
  const t = useTranslate()
  const providers = useProviders((state) => state.providers)
  const activeId = useProviders((state) => state.activeId)
  const active = providers.find((provider) => provider.id === activeId) ?? providers[0]

  return (
    <>
      <div role="radiogroup" aria-label={t('providerListLabel')} className={styles.providerList}>
        {providers.map((provider) => (
          <div key={provider.id} className={styles.providerRow}>
            <button
              type="button"
              role="radio"
              aria-checked={provider.id === active.id}
              className={clsx(
                styles.providerSelect,
                provider.id === active.id && styles.providerSelectActive
              )}
              onClick={() => setActiveProvider(provider.id)}
            >
              <span className={styles.providerName}>{provider.name}</span>
              {provider.builtin ? (
                <span className={styles.providerTag}>{t('providerBuiltin')}</span>
              ) : null}
            </button>
            {provider.builtin ? null : (
              <IconButton
                icon={<IconTrashOutline16 />}
                tooltip={t('delete')}
                onClick={() => removeProvider(provider.id)}
              />
            )}
          </div>
        ))}
      </div>
      <button
        type="button"
        className={styles.providerAdd}
        onClick={() => addProvider(t('providerDefaultName'))}
      >
        <span aria-hidden>+</span>
        {t('providerAdd')}
      </button>
      <ProviderEditor key={active.id} provider={active} />
    </>
  )
}
