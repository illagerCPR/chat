import { create } from 'zustand'
import { getActiveProvider, isProviderReady } from '../../services/providers.js'

/** 设置弹窗的分组：通用设置 / 提供商 / 数据管理 */
export type SettingsSection = 'general' | 'providers' | 'data'

/** 设置弹窗：侧边栏底部、没有可用提供商时的操作与 401 提示都可以打开；section 为打开时选中的分组 */
export const useSettingsDialog = create(() => ({
  open: false,
  section: 'general' as SettingsSection,
}))

export const openSettings = (section: SettingsSection) =>
  useSettingsDialog.setState({ open: true, section })

export const closeSettings = () => useSettingsDialog.setState({ open: false })

/** 当前提供商还不能发起请求时，打开设置并选中「提供商」，返回是否可以继续 */
export const ensureProviderReady = () => {
  if (isProviderReady(getActiveProvider())) {
    return true
  }
  openSettings('providers')
  return false
}
