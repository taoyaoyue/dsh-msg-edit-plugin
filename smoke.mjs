// 离线冒烟测试：不启动 DSH，直接跑 client.js 的模块体 + 组件函数。
// 假 React 有状态、setState 会重渲染；假 ctx 提供会话/插槽/远程调用桩。
// 覆盖：接线、轮次数字、原话预填、按钮显隐、二次确认、fork 边界、重发内容。
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const bundle = process.argv[2]
const root = path.dirname(path.resolve(bundle, 'package.json'))

let captured
globalThis.window = {
  __ModuleLoader__: {
    load(entry) {
      captured = entry
    },
  },
}
globalThis.document = { body: {} }

let runningState = false

// ---- 假 React ----
let cells = []
let cursor = 0
let dirty = false
const stateByComponent = new WeakMap()

const fakeReact = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
  Fragment: 'Fragment',
  useState(initial) {
    const store = cells
    const index = cursor
    cursor += 1
    if (!(index in store)) store[index] = typeof initial === 'function' ? initial() : initial
    const set = (next) => {
      const value = typeof next === 'function' ? next(store[index]) : next
      if (Object.is(value, store[index])) return
      store[index] = value
      dirty = true
    }
    return [store[index], set]
  },
  useRef(initial) {
    return { current: initial }
  },
  useMemo(factory) {
    return factory()
  },
  useCallback(fn) {
    return fn
  },
  useEffect(fn) {
    fn()
  },
  memo(fn) {
    return fn
  },
}

/** 渲染一个组件，并把 setState 引起的重渲染跑完（有上限，防死循环）。 */
function render (component, props) {
  let store = stateByComponent.get(component)
  if (store === undefined) {
    store = []
    stateByComponent.set(component, store)
  }
  cells = store
  let tree
  for (let pass = 0; pass < 20; pass += 1) {
    cursor = 0
    dirty = false
    tree = component(props)
    if (!dirty) break
  }
  return tree
}

/** 递归展开函数组件元素，得到真正的 DOM 树。 */
function expandAll (node) {
  if (node === null || node === undefined || typeof node !== 'object') return node
  if (Array.isArray(node)) return node.map(expandAll)
  if (typeof node.type === 'function') return expandAll(render(node.type, node.props))
  return { ...node, children: (node.children ?? []).map(expandAll) }
}

function walk (node, out = []) {
  if (node === null || node === undefined || typeof node === 'boolean') return out
  if (typeof node !== 'object') return out
  if (Array.isArray(node)) {
    for (const item of node) walk(item, out)
    return out
  }
  out.push(node)
  for (const child of node.children ?? []) walk(child, out)
  return out
}

function findAll (tree, predicate) {
  return walk(tree).filter(predicate)
}

function byLabel (tree, label) {
  return findAll(tree, (node) => node.props !== undefined && node.props['aria-label'] === label)
}

function textOf (tree) {
  const out = []
  const visit = (node) => {
    if (node === null || node === undefined || typeof node === 'boolean') return
    if (typeof node === 'string') {
      out.push(node)
      return
    }
    if (Array.isArray(node)) {
      for (const item of node) visit(item)
      return
    }
    if (node.type === 'style') return
    for (const child of node.children ?? []) visit(child)
  }
  visit(tree)
  return out
}

const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
await import(pathToFileURL(path.join(root, manifest.exports['./client'])).href)

if (captured === undefined) throw new Error('client.js 没有调用 window.__ModuleLoader__.load')
if (captured.id !== manifest.name) throw new Error(`模块 id (${captured.id}) 和包名 (${manifest.name}) 不一致`)

const plugin = captured.factory((name) => {
  if (name === 'react') return fakeReact
  if (name === 'react-dom') return { createPortal: (node) => node }
  throw new Error(`client.js 请求了未声明的模块：${name}`)
})

// ---- 假会话：两轮，第 2 轮提问"第二问" ----
const events = [
  { seq: 1, type: 'turn/start', data: { turn: 1 } },
  { seq: 2, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '第一问' }], surfaceOp: 'append' } },
  { seq: 3, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '第一答' }] } }, surfaceOp: 'append' },
  { seq: 4, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
  { seq: 5, type: 'model/selection', data: { provider: 'magpie', model: 'volcengine/deepseek-v4.1-flash', reasoningEffort: 'max' } },
  { seq: 6, type: 'turn/start', data: { turn: 2 } },
  { seq: 7, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '第二问' }], surfaceOp: 'append' } },
  { seq: 8, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '第二答' }] } }, surfaceOp: 'append' },
  { seq: 9, type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } },
]

const calls = { renamed: [], prompted: [], archived: [], opened: [], log: [], viaUi: 0, viaWorkspaces: 0 }

const parentSession = {
  getSnapshot: () => ({ running: runningState }),
  subscribe: () => () => {},
  rename: async (title) => { calls.parentTitle = title },
  eventSource: {
    getSnapshot: () => ({ entries: events.map((event) => ({ type: 'event', event })) }),
    subscribe: () => () => {},
  },
}

// 子会话：fork 会把父会话"排着队还没发"的两条带过来
const childInbox = { 'next-turn': [{ id: 'q1' }, { id: 'q2' }], 'next-step': [] }
const childSession = {
  getSnapshot: () => ({ running: false }),
  subscribe: () => () => {},
  rename: async (title) => { calls.renamed.push(title) },
  prompt: async (content) => { calls.prompted.push(content); calls.log.push('prompt'); return { ok: true } },
  updateQueue: async (itemId, action) => { calls.log.push(`queue:${itemId}:${action.kind}`) },
  projections: { faceOf: (key) => (key === 'inbox' ? { getSnapshot: () => childInbox } : { getSnapshot: () => undefined }) },
  eventSource: { getSnapshot: () => ({ entries: [] }), subscribe: () => () => {} },
}

const archiveImpl = async (id, options) => {
  calls.log.push(`archive:${id}`)
  calls.archived.push([id, options?.stopActivity === true])
  if (calls.failArchive === true && id === 'session-test') {
    const error = new Error('workspace session archive failed: workspace/session-active: session has running work')
    error.name = 'WorkspaceArchiveError'
    error.rpcError = {
      code: 'workspace/session-active',
      message: 'session has running work',
      details: {
        sessionId: id,
        activity: [{ kind: 'subagent', items: [{ id: 'sub-8fdfcde2', label: '核对 03a 收尾' }] }],
      },
    }
    throw error
  }
}

const registrations = []
const fakeCtx = {
  sessions: {
    binding: (id) => (id === 'session-test'
      ? { session: parentSession }
      : (id === 'child-1' || id === 'child-2' ? { session: childSession } : undefined)),
    list: { getSnapshot: () => ({ byId: { 'session-test': { title: '测试会话', cwd: 'C:/tmp' } } }) },
    fork: async (opts) => { calls.forkedAt = opts.atSeq; return 'child-1' },
    create: async () => 'child-2',
  },
  get: (name) => {
    if (name === 'uiWorkspace') {
      return {
        openSession: (id) => { calls.opened.push(id); calls.log.push(`open:${id}`) },
        archiveSession: async (id, options) => { calls.viaUi += 1; return archiveImpl(id, options) },
      }
    }
    if (name === 'workspaces') {
      return { archiveSession: async (id, options) => { calls.viaWorkspaces += 1; return archiveImpl(id, options) } }
    }
    return undefined
  },
  slots: {
    inject: (ownerKey, callback) => { callback() },
    register: (options, component) => { registrations.push({ options, component }); return () => {} },
  },
}

plugin.apply(fakeCtx)

const tail = registrations.find((entry) => entry.options.name === 'conversation.chat.turnTail')
const strip = registrations.find((entry) => entry.options.name === 'conversation.input.overlay')
if (tail === undefined) throw new Error('没有注册 turnTail 插槽')
if (strip === undefined) throw new Error('没有注册 input.overlay 插槽（编辑条）')

const tailProps = tail.options.inject('session-test')
const stripProps = strip.options.inject('session-test')
const tailTree = (props) => expandAll(render(tail.component, {
  turn: { turn: 2 },
  seq: 9,
  sessionId: 'session-test',
  ops: tailProps.ops,
  ...props,
}))

// 1) 轮次反查
const info2 = tailProps.ops.turnAt('session-test', 9)
if (info2.ok !== true) throw new Error('turnAt 失败：' + info2.reason)
if (info2.number !== 2) throw new Error(`轮次号错了：${info2.number}`)
if (info2.startSeq !== 6) throw new Error(`turn/start 序号错了：${info2.startSeq}`)
if (info2.isLast !== true) throw new Error('第 2 轮应该是最后一轮')
if (info2.text !== '第二问') throw new Error(`原话取错：${JSON.stringify(info2.text)}`)

const info1 = tailProps.ops.turnAt('session-test', 3)
if (info1.number !== 1) throw new Error('第 1 轮号错了')
if (info1.isLast !== false) throw new Error('第 1 轮不该是最后一轮')
if (info1.text !== '第一问') throw new Error('第 1 轮原话取错')

// 2) 空闲 + 最后一轮：铅笔和垃圾桶都在
runningState = false
const lastTree = tailTree()
if (byLabel(lastTree, '编辑这一轮的提问').length !== 1) throw new Error('缺少铅笔按钮')
if (byLabel(lastTree, '删除这段对话').length !== 1) throw new Error('最后一轮应能删除')

// 3) 非最后一轮：只有铅笔
const oldTree = expandAll(render(tail.component, { turn: { turn: 1 }, seq: 3, sessionId: 'session-test', ops: tailProps.ops }))
if (byLabel(oldTree, '删除这段对话').length !== 0) throw new Error('非最后一轮不该出现垃圾桶')

// 4) 在跑：垃圾桶消失、铅笔禁用
runningState = true
const busyTree = tailTree()
if (byLabel(busyTree, '删除这段对话').length !== 0) throw new Error('在跑时不允许出现垃圾桶')
const pencilBusy = byLabel(busyTree, '编辑这一轮的提问')
if (pencilBusy.length !== 1 || pencilBusy[0].props.disabled !== true) throw new Error('在跑时铅笔必须禁用')
runningState = false

// 5) 点铅笔 → 编辑条出现：具体轮次 + 预填原话
if (render(strip.component, stripProps) !== null) throw new Error('还没点铅笔时编辑条不该出现')
byLabel(tailTree(), '编辑这一轮的提问')[0].props.onClick()
const stripTree = expandAll(render(strip.component, stripProps))
if (stripTree === null) throw new Error('点了铅笔后编辑条没出现')
const stripText = textOf(stripTree)
if (!stripText.some((line) => line.includes('第 2 轮'))) throw new Error(`编辑条标题不对：${stripText.join(' | ')}`)
if (stripText.some((line) => line.includes('[object'))) throw new Error('标题里出现了 [object Object]')
const textarea = findAll(stripTree, (node) => node.type === 'textarea')
if (textarea.length !== 1) throw new Error('编辑条里没有输入框')
if (textarea[0].props.value !== '第二问') throw new Error(`输入框没有预填原话，实际：${JSON.stringify(textarea[0].props.value)}`)

// 6) 点垃圾桶 → 二次确认弹层出现（带取消/删除）
byLabel(tailTree(), '删除这段对话')[0].props.onClick()
const confirmTree = tailTree()
const confirmText = textOf(confirmTree)
if (!confirmText.some((line) => line.includes('确定要删除这段对话吗'))) {
  throw new Error(`二次确认没出现，实际文本：${confirmText.join(' | ')}`)
}
const buttons = findAll(confirmTree, (node) => node.type === 'button')
if (!buttons.some((node) => (node.children ?? []).includes('删除'))) throw new Error('确认弹层里没有"删除"按钮')
if (!buttons.some((node) => (node.children ?? []).includes('取消'))) throw new Error('确认弹层里没有"取消"按钮')

// 7) 删除路径：切在第 2 轮之前（seq 5），旧会话归档，跳到新对话
calls.log.length = 0
calls.archived.length = 0
await tailProps.ops.rewrite('session-test', 6, undefined)
if (calls.forkedAt !== 5) throw new Error(`fork 边界错：期望 5，实际 ${calls.forkedAt}`)
if (JSON.stringify(calls.archived[0]) !== JSON.stringify(['session-test', false])) {
  throw new Error(`归档旧会话时不能带 stopActivity（会杀掉正在跑的子 agent），实际：${JSON.stringify(calls.archived)}`)
}
if (calls.opened.at(-1) !== 'child-1') throw new Error('没有跳到新对话')
if (!calls.log.includes('queue:q1:remove') || !calls.log.includes('queue:q2:remove')) {
  throw new Error(`继承来的排队消息没清掉：${JSON.stringify(calls.log)}`)
}
if (calls.log.includes('prompt')) throw new Error('删除路径不该发消息')
if (typeof calls.parentTitle !== 'string' || !calls.parentTitle.endsWith('\u200c\u200d')) {
  throw new Error(`旧会话没打删除记号：${JSON.stringify(calls.parentTitle)}`)
}
// 归档必须发生在跳转之前：否则归档失败时用户已经被送到复制品里
if (calls.log.indexOf('archive:session-test') > calls.log.indexOf('open:child-1')) {
  throw new Error(`归档要在跳转之前，实际顺序：${JSON.stringify(calls.log)}`)
}
// 归档优先走 uiWorkspace（它会清主视图引用），不是直接怼底层 workspaces
if (calls.viaUi === 0) throw new Error('归档应该优先走 uiWorkspace.archiveSession')
if (calls.viaWorkspaces !== 0) throw new Error('uiWorkspace 可用时不该退回 workspaces')

// 8) 编辑路径
calls.log.length = 0
await tailProps.ops.rewrite('session-test', 6, '改过的第二问')
if (JSON.stringify(calls.prompted.at(-1)) !== JSON.stringify([{ type: 'text', text: '改过的第二问' }])) {
  throw new Error(`重发内容不对：${JSON.stringify(calls.prompted.at(-1))}`)
}
if (calls.renamed.at(-1) !== '测试会话') throw new Error('标题没继承')
if (calls.log.indexOf('prompt') < calls.log.lastIndexOf('queue:')) {
  throw new Error(`排队消息必须在发送前清掉，实际顺序：${JSON.stringify(calls.log)}`)
}

// 8b) 归档失败（会话还有后台活动）→ 报错、不跳转、不发消息、复制品被收进归档
calls.log.length = 0
calls.archived.length = 0
calls.opened.length = 0
calls.failArchive = true
let archiveFailed = false
let archiveMessage = ''
try {
  await tailProps.ops.rewrite('session-test', 6, undefined)
} catch (error) {
  archiveFailed = true
  archiveMessage = String(error.message)
}
calls.failArchive = false
if (!archiveFailed) throw new Error('归档失败时必须报错，不能静默留下复制品')
if (calls.opened.length !== 0) throw new Error('归档失败时不该跳转')
if (calls.log.includes('prompt')) throw new Error('归档失败时不该发消息')
if (!calls.archived.some((entry) => entry[0] === 'child-1')) {
  throw new Error(`归档失败后应把复制品收进归档：${JSON.stringify(calls.archived)}`)
}
// 归档被拒时:报出谁在跑、恢复标题、不带 stopActivity
if (!archiveMessage.includes('子 agent')) throw new Error(`报错没说清是谁在跑：${archiveMessage}`)
if (!archiveMessage.includes('核对 03a 收尾')) throw new Error(`报错没带上 label：${archiveMessage}`)
if (!archiveMessage.includes('不会替你停掉')) throw new Error(`报错没表明不会强杀：${archiveMessage}`)
if (calls.parentTitle !== '测试会话') throw new Error(`归档失败要把标题恢复回去，实际：${JSON.stringify(calls.parentTitle)}`)
if (calls.archived[0][1] !== false) throw new Error(`归档旧会话不能带 stopActivity：${JSON.stringify(calls.archived)}`)

// 9) 在跑时调用必须被挡住
runningState = true
let blocked = false
try {
  await tailProps.ops.rewrite('session-test', 6, 'x')
} catch (error) {
  blocked = true
}
if (!blocked) throw new Error('在跑时 rewrite 应该拒绝')
runningState = false

// 10) 空 sessionId 不渲染
if (render(tail.component, { turn: { turn: 2 }, seq: 9, sessionId: undefined, ops: tailProps.ops }) !== null) {
  throw new Error('sessionId 缺失时应该不渲染')
}

console.log('SMOKE OK')
console.log('  插槽      :', registrations.map((entry) => entry.options.name).join(' + '))
console.log('  轮次反查  : 第 %d 轮 / start=%d / 最后一轮=%s', info2.number, info2.startSeq, info2.isLast)
console.log('  预填原话  :', JSON.stringify(textarea[0].props.value))
console.log('  编辑条标题:', JSON.stringify(stripText.find((line) => line.includes('编辑中'))))
console.log('  二次确认  :', JSON.stringify(confirmText.find((line) => line.includes('确定要删除'))))
console.log('  fork 边界 :', calls.forkedAt, '（第 2 轮 turn/start = 6）')
console.log('  重发内容  :', JSON.stringify(calls.prompted.at(-1)))
console.log('  归档通道  :', `uiWorkspace×${calls.viaUi} / workspaces×${calls.viaWorkspaces}`)
console.log('  标题      :', JSON.stringify(calls.renamed.at(-1)))
