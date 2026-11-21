import { useState, type ReactNode } from 'react'
import clsx from 'clsx'
import { useTranslate, type TranslationKey } from '../../i18n/index.js'
import { IconTrashOutline16 } from '../base/icons.js'
import { IconButton } from '../base/IconButton.js'
import { Select } from '../base/Select.js'
import { listModels } from '../../services/api/models.js'
import {
  addProvider,
  isCapabilitySupported,
  isValidBaseUrl,
  normalizeBaseUrl,
  removeProvider,
  setActiveProvider,
  updateProvider,
  useProviders,
  type Provider,
  type ProviderCapabilities,
  type ProviderProtocol,
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

const PROTOCOLS: { value: ProviderProtocol; label: TranslationKey }[] = [
  { value: 'deepseek', label: 'providerProtocolDeepseek' },
  { value: 'openai', label: 'providerProtocolOpenai' },
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
  const [models, setModels] = useState<string[]>([])
  const [fetchingModels, setFetchingModels] = useState(false)
  const [modelsError, setModelsError] = useState(false)
  const modelListId = `provider-models-${provider.id}`

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

  const fetchModels = async () => {
    setModelsError(false)
    setFetchingModels(true)
    try {
      const ids = await listModels(provider)
      setModels(ids)
      setModelsError(ids.length === 0)
    } catch {
      setModelsError(true)
    } finally {
      setFetchingModels(false)
    }
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
      <Field label={t('providerProtocolLabel')}>
        <div>
          <Select
            value={provider.protocol}
            options={PROTOCOLS.map((item) => ({ value: item.value, label: t(item.label) }))}
            disabled={provider.builtin}
            ariaLabel={t('providerProtocolLabel')}
            onChange={(protocol) => {
              setModels([])
              setModelsError(false)
              updateProvider(provider.id, { protocol })
            }}
          />
        </div>
        <div className={styles.description}>{t('providerProtocolHint')}</div>
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
        <div className={styles.providerInputRow}>
          <input
            className={styles.providerInput}
            value={model}
            list={models.length > 0 ? modelListId : undefined}
            placeholder={t(
              provider.protocol === 'openai'
                ? 'providerModelPlaceholderOpenai'
                : 'providerModelPlaceholder'
            )}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => setModel(event.target.value)}
            onBlur={commitModel}
            onKeyDown={commitOnEnter}
          />
          <button
            type="button"
            className={styles.providerInlineButton}
            disabled={fetchingModels || !isValidBaseUrl(provider.baseUrl)}
            onClick={() => void fetchModels()}
          >
            {fetchingModels ? t('providerModelsLoading') : t('providerModelsFetch')}
          </button>
        </div>
        {models.length > 0 ? (
          <datalist id={modelListId}>
            {models.map((id) => (
              <option key={id} value={id} />
            ))}
          </datalist>
        ) : null}
      </Field>
      {modelsError ? <div className={styles.error}>{t('providerModelsFailed')}</div> : null}
      <ApiKeyField provider={provider} />
      <div className={styles.providerField}>
        <div className={styles.label}>{t('providerCapabilitiesLabel')}</div>
        <div className={styles.providerCapabilityList}>
          {CAPABILITIES.map((item) => {
            // 协议本身不具备的能力置灰：勾着也不会生效，避免造成已启用的误解
            const supported = isCapabilitySupported(provider.protocol, item.key)
            return (
              <label
                key={item.key}
                className={clsx(
                  styles.providerCapability,
                  !supported && styles.providerCapabilityDisabled
                )}
              >
                <input
                  type="checkbox"
                  checked={supported && provider.capabilities[item.key]}
                  disabled={!supported}
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
            )
          })}
        </div>
        <div className={styles.description}>{t('providerCapabilitiesHint')}</div>
      </div>
      <div className={styles.description}>
        {t(provider.protocol === 'openai' ? 'providerEndpointHintOpenai' : 'providerEndpointHint')}
      </div>
    </div>
  )
}

/**
 * 提供商设置：列表里选当前启用的一项，下方编辑它的协议、地址、Key、模型与能力。
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
