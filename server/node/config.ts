import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AuthConfig } from '../core/auth.ts'
import type { RouterLimits } from '../core/router.ts'

/** 运行时配置；全部来自环境变量，未设置时用容器内的默认值。 */
export type ServerConfig = {
  host: string
  port: number
  /** SQLite 数据库所在目录，容器内挂载为数据卷 */
  dataDir: string
  /** 前端构建产物目录 */
  distDir: string
  /** null 表示不做访问控制 */
  auth: AuthConfig | null
  limits: RouterLimits
}

const MB = 1024 * 1024
/** 服务端默认放行到 64 MB，与前端附件上限一致 */
const DEFAULT_MAX_FILE_MB = 64
const DEFAULT_MAX_SESSION_MB = 32
const DEFAULT_PORT = 3000

const intFromEnv = (name: string, fallback: number): number => {
  const raw = process.env[name]
  if (raw === undefined || raw.trim() === '') {
    return fallback
  }
  const value = Number(raw)
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer, received ${JSON.stringify(raw)}`)
  }
  return value
}

const stringFromEnv = (name: string, fallback: string): string => {
  const raw = process.env[name]
  return raw === undefined || raw.trim() === '' ? fallback : raw.trim()
}

/** 默认产物目录按本文件位置推导：源码在 server/node/，产物在仓库根的 dist/。 */
const defaultDistDir = () => fileURLToPath(new URL('../../dist', import.meta.url))

export const loadConfig = (): ServerConfig => {
  const password = process.env.CHAT_PASSWORD?.trim() ?? ''
  return {
    host: stringFromEnv('HOST', '0.0.0.0'),
    port: intFromEnv('PORT', DEFAULT_PORT),
    dataDir: path.resolve(stringFromEnv('CHAT_DATA_DIR', '/data')),
    distDir: path.resolve(stringFromEnv('CHAT_DIST_DIR', defaultDistDir())),
    auth:
      password === ''
        ? null
        : { username: stringFromEnv('CHAT_USERNAME', 'chat'), password },
    limits: {
      maxSessionBytes: intFromEnv('CHAT_MAX_SESSION_MB', DEFAULT_MAX_SESSION_MB) * MB,
      maxFileBytes: intFromEnv('CHAT_MAX_FILE_MB', DEFAULT_MAX_FILE_MB) * MB,
    },
  }
}
