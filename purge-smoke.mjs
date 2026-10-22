// Host 半边（index.js）的离线自测：在临时 DSH_HOME 里造几个会话目录，验证
// 「已归档 + 标题带零宽空格 + 里确有 session.* 日志」三条都满足才删，
// 少一条都不许动。不需要 DSH 在跑。
import { mkdir, writeFile, readFile, rm, access } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const here = import.meta.dirname
const root = path.join(here, '.purge-test')
const fixtures = path.join(root, 'sessions', 'bucket--one--')
const cache = path.join(root, 'storages', 'session_projcache', 'sessions')

/** 每个样本：id、标题、归档与否、目录里放什么、期望是否被删。 */
const samples = [
  { id: 'session-marked', title: '要删的会话\u200b', archived: true, files: ['session.v4.jsonl.zstd'], expectDeleted: true },
  { id: 'session-unmarked', title: '没归档的会话\u200b', archived: false, files: ['session.v4.jsonl.zstd'], expectDeleted: false },
  { id: 'session-no-log', title: '目录里没有日志\u200b', archived: true, files: ['notes.txt'], expectDeleted: false },
  { id: 'session-plain-title', title: '标题没记号', archived: true, files: ['session.v4.jsonl.zstd'], expectDeleted: false },
]

await rm(root, { recursive: true, force: true })
await mkdir(cache, { recursive: true })
for (const sample of samples) {
  const dir = path.join(fixtures, sample.id)
  await mkdir(dir, { recursive: true })
  for (const file of sample.files) await writeFile(path.join(dir, file), 'dummy')
  if (sample.id === 'session-marked') {
    await writeFile(path.join(cache, `${sample.id}.json`), '{"x":1}')
    await writeFile(path.join(cache, `${sample.id}.json.bak`), '{"x":0}')
  }
}

process.env.DSH_HOME = root

const fakeCtx = {
  get(name) {
    if (name === 'workspaceRegistry') {
      return { archivedSessionIds: samples.filter((sample) => sample.archived).map((sample) => sample.id) }
    }
    if (name === 'sessionQuery') {
      return {
        async observeSession(id) {
          const title = samples.find((sample) => sample.id === id)?.title
          return {
            projections: { values: { title } },
            [Symbol.dispose]() {},
          }
        },
      }
    }
    return undefined
  },
}

const mod = await import(pathToFileURL(path.join(here, 'index.js')).href)
if (typeof mod.sweep !== 'function') throw new Error('index.js 没有导出 sweep，Host 半边测不了')
await mod.sweep(fakeCtx)

const exists = async (target) => {
  try {
    await access(target)
    return true
  } catch {
    return false
  }
}

let ok = true
for (const sample of samples) {
  const dir = path.join(fixtures, sample.id)
  const deleted = !(await exists(dir))
  const pass = deleted === sample.expectDeleted
  if (!pass) ok = false
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${sample.id}  ${sample.expectDeleted ? '应删除' : '应保留'}  实际${deleted ? '删除' : '保留'}`)
}

const cached = await exists(path.join(cache, 'session-marked.json'))
const backedUp = await exists(path.join(cache, 'session-marked.json.bak'))
console.log(`${cached || backedUp ? 'FAIL' : 'PASS'}  投影缓存（含 .bak）一起清掉`)
if (cached || backedUp) ok = false

const log = await readFile(path.join(root, 'msg-edit-purge.log'), 'utf8')
console.log('--- msg-edit-purge.log ---')
console.log(log.trim())

await rm(root, { recursive: true, force: true })
console.log(ok ? 'PURGE OK' : 'PURGE FAILED')
process.exit(ok ? 0 : 1)
