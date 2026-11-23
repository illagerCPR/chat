import { loadConfig } from './node/config.ts'
import { startServer } from './node/server.ts'
import { openDatabase, SqliteChatStore } from './store/sqlite.ts'

const config = loadConfig()

let store: SqliteChatStore
try {
  store = new SqliteChatStore(openDatabase(config.dataDir))
} catch (error) {
  console.error(`[chat] cannot open database in ${config.dataDir}`, error)
  process.exit(1)
}

startServer(config, store)
