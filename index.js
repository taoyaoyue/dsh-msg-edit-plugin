/**
 * Host 半边：把被「删除这段对话」替换掉的旧会话从磁盘上清掉。
 *
 * 约定：Client 先把旧会话的标题末尾加一对零宽连接符（U+200C U+200D），再把它归档。
 * 为什么不用 U+200B：DSH 的标题归一化（dsh-session-title 的 DIRECTIONAL_CONTROL）会把
 * U+200B / U+FEFF / 方向控制符删掉，记号存不进标题，purge 就永远不会触发；
 * U+200C / U+200D 不在那份名单里，能活下来。
 * 这里扫「已归档的会话」，标题带这个记号的才删，且只删目录名与 sessionId 完全相等的目录。
 * 另有旁证日志 <DSH_HOME>/msg-edit-purge.log，删了什么都记一行。
 */
import { appendFile, readdir, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const MARK = '\u200c\u200d'
const FIRST_SWEEP_MS = 15000
const SWEEP_INTERVAL_MS = 5 * 60 * 1000

export function apply(ctx) {
  const run = () => {
    void sweep(ctx).catch(() => {})
  }
  const first = setTimeout(run, FIRST_SWEEP_MS)
  const timer = setInterval(run, SWEEP_INTERVAL_MS)
  ctx.effect(() => () => {
    clearTimeout(first)
    clearInterval(timer)
  }, 'msg-edit: purge sweeper')
}

function homeRoot() {
  const home = process.env.DSH_HOME
  if (typeof home === 'string' && home.trim() !== '') return home.trim()
  return path.join(os.homedir(), '.dsh')
}

/** 扫一遍已归档会话，删掉带删除记号的。定时器和测试都走这一个入口。 */
export async function sweep(ctx) {
  if (typeof ctx.get !== 'function') return
  const registry = ctx.get('workspaceRegistry')
  const query = ctx.get('sessionQuery')
  if (registry === undefined || query === undefined) return
  const archived = Array.isArray(registry.archivedSessionIds) ? [...registry.archivedSessionIds] : []
  for (const sessionId of archived) {
    if (typeof sessionId !== 'string' || sessionId === '') continue
    if (await markedForDeletion(query, sessionId)) await purgeSession(sessionId)
  }
}

async function markedForDeletion(query, sessionId) {
  let observation
  try {
    observation = await query.observeSession(sessionId)
    const title = observation?.projections?.values?.title
    return typeof title === 'string' && title.endsWith(MARK)
  } catch (error) {
    return false
  } finally {
    const dispose = observation?.[Symbol.dispose]
    if (typeof dispose === 'function') {
      try {
        dispose.call(observation)
      } catch (error) {
        // 释放失败不影响判断结果
      }
    }
  }
}

async function purgeSession(sessionId) {
  const root = homeRoot()
  const sessionsRoot = path.join(root, 'sessions')
  if (!existsSync(sessionsRoot)) return
  const entries = await readdir(sessionsRoot, { withFileTypes: true })
  for (const bucket of entries) {
    if (!bucket.isDirectory()) continue
    const dir = path.resolve(sessionsRoot, bucket.name, sessionId)
    if (path.basename(dir) !== sessionId) continue
    if (!dir.startsWith(path.resolve(sessionsRoot) + path.sep)) continue
    if (!existsSync(dir)) continue
    // 再验一次"这确实是会话目录"：里面必须有 session.* 日志，删错目录的代价太大
    const inside = await readdir(dir, { withFileTypes: true })
    if (!inside.some((entry) => entry.isFile() && entry.name.startsWith('session.'))) {
      await note(root, `skip ${sessionId} -> ${dir} (没有 session.* 日志，不是会话目录)`)
      continue
    }
    await note(root, `remove ${sessionId} -> ${dir}`)
    await rm(dir, { recursive: true, force: true })
    await dropProjectionCache(root, sessionId)
  }
  // 会话目录早就不在了也要清缓存，否则投影缓存会一直留着这个已经删掉的会话
  await dropProjectionCache(root, sessionId)
}

/** 清掉这个会话的投影缓存（`<id>.json`、`<id>.json.bak` 都算）。 */
async function dropProjectionCache(root, sessionId) {
  const dir = path.join(root, 'storages', 'session_projcache', 'sessions')
  if (!existsSync(dir)) return
  const prefix = `${sessionId}.json`
  const entries = await readdir(dir, { withFileTypes: true })
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.startsWith(prefix)) continue
    await rm(path.join(dir, entry.name), { force: true })
  }
}

async function note(root, line) {
  try {
    await appendFile(path.join(root, 'msg-edit-purge.log'), `${new Date().toISOString()}\t${line}\n`, 'utf8')
  } catch (error) {
    // 日志写不了就算了
  }
}
