/**
 * 对话存储的统一入口。具体实现在 ./storage/ 下，按部署形态二选一：
 * 静态部署用浏览器 IndexedDB，自托管部署用同源的存储服务。
 * 业务代码只依赖这里导出的函数，不需要关心数据落在哪。
 */
export type { StoredFile } from './storage/types.js'
export {
  addStagingSession,
  clearStaging,
  commitStaging,
  deleteSession,
  getStorageInfo,
  loadFile,
  loadSession,
  loadSessionSummaries,
  renameSession,
  reportStorageError,
  saveFiles,
  saveSession,
  saveStagingFiles,
  updateStagingFileTypes,
  type StorageInfo,
  type StorageMode,
} from './storage/index.js'
