/**
 * 改这一轮的提问并重发 / 删除这一段对话（提问 + 回答）。
 *
 * 交互照 Cherry Studio：
 *   - 每轮末尾：铅笔（编辑这一轮的提问）+ 垃圾桶（仅本轮，删掉这段对话）
 *   - 点铅笔 → 输入框上方出现「编辑中」条，输入框里预填你原来的提问
 *   - 点垃圾桶 → 弹「确定要删除这段对话吗？」二次确认
 *
 * 实现原理（不改核心、不改 app.asar）：
 *   会话日志是 append-only 的，所以"原地改"= 用官方的 session.fork 在"这一轮开始之前"
 *   切一份新会话（前缀完全相同），把改好的话作为新会话的第一条消息发出去，
 *   再把旧会话 archive 掉、标题改成和旧的一样 —— 观感上就是同一个对话接着往下走。
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-msg-edit',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    // 确认框挂到 body 上，避免被聊天区的 transform/overflow 裁掉
    const ReactDOM = (() => {
      try {
        return require('react-dom')
      } catch (error) {
        return undefined
      }
    })()

    const CSS = `
.dme-actions{display:inline-flex;align-items:center;gap:2px;margin-right:6px}
.dme-icon{appearance:none;display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;
  padding:0;border:1px solid transparent;border-radius:var(--dsw-radius-sm,6px);background:transparent;cursor:pointer;
  color:var(--dsw-alias-label-tertiary)}
.dme-icon:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dme-icon:focus-visible{outline:2px solid var(--dsw-focus-ring-color);outline-offset:1px}
.dme-icon[disabled]{opacity:.35;cursor:default;background:transparent;color:var(--dsw-alias-label-tertiary)}
.dme-icon-danger:hover{color:var(--dsw-alias-state-error-primary)}
.dme-icon svg{width:15px;height:15px;fill:currentColor;pointer-events:none}

.dme-strip{position:absolute;left:0;right:0;bottom:0;z-index:5;display:flex;flex-direction:column;gap:6px;
  padding:10px 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg,12px);
  background:var(--dsw-alias-bg-layer-1);box-shadow:var(--dsw-elevation-panel);
  color:var(--dsw-alias-label-primary);font:inherit}
.dme-strip-head{display:flex;align-items:center;gap:6px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.dme-strip-input{width:100%;box-sizing:border-box;min-height:72px;max-height:30vh;resize:vertical;padding:8px 10px;
  border:1px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-md,10px);
  background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:1.6}
.dme-strip-input:focus{outline:none;border-color:var(--dsw-focus-ring-color)}
.dme-hint{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.dme-error{font-size:12px;line-height:18px;color:var(--dsw-alias-state-error-primary);white-space:pre-wrap}
.dme-row{display:flex;align-items:center;justify-content:flex-end;gap:8px}

.dme-backdrop{position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;
  background:color-mix(in srgb, var(--dsw-alias-bg-base) 45%, transparent);backdrop-filter:var(--dsw-menu-backdrop-filter)}
.dme-dialog{width:min(440px,calc(100vw - 64px));display:flex;flex-direction:column;gap:14px;padding:24px;
  border-radius:18px;background:var(--dsw-alias-bg-layer-1);box-shadow:var(--dsw-elevation-prominent);
  color:var(--dsw-alias-label-primary);font:inherit}
.dme-dialog-title{font-size:18px;font-weight:600;text-align:center;line-height:1.5}
.dme-dialog-body{font-size:13px;line-height:1.7;color:var(--dsw-alias-label-secondary);text-align:center}
.dme-btn{appearance:none;border-radius:10px;padding:8px 20px;font:inherit;font-size:14px;cursor:pointer}
.dme-btn-ghost{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary)}
.dme-btn-ghost:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dme-btn-danger{border:1px solid transparent;background:var(--dsw-alias-state-error-primary);color:#fff}
.dme-btn-danger[disabled],.dme-btn-ghost[disabled]{opacity:.55;cursor:default}
`

    // ---- 跨插槽的编辑态：铅笔（轮尾）写，编辑条（输入框上方）读 ----
    const editors = new Map()
    const editorListeners = new Set()

    function readEditor(sessionId) {
      return sessionId === undefined ? undefined : editors.get(sessionId)
    }

    function writeEditor(sessionId, value) {
      if (sessionId === undefined) return
      if (value === undefined) editors.delete(sessionId)
      else editors.set(sessionId, value)
      for (const listener of editorListeners) listener()
    }

    function useEditor(sessionId) {
      const [revision, bump] = React.useState(0)
      React.useEffect(() => {
        const listener = () => bump((value) => value + 1)
        editorListeners.add(listener)
        return () => {
          editorListeners.delete(listener)
        }
      }, [])
      return { value: readEditor(sessionId), revision }
    }

    /** 事件窗口版本号：新消息落地时让轮尾按钮重新计算"是不是最后一轮"。 */
    function useEventRevision(ops, sessionId) {
      const [revision, bump] = React.useState(0)
      React.useEffect(() => {
        const session = ops.sessionOf(sessionId)
        const source = session === undefined ? undefined : session.eventSource
        if (source === undefined || typeof source.subscribe !== 'function') return undefined
        return source.subscribe(() => bump((value) => value + 1))
      }, [ops, sessionId])
      return revision
    }

    /** 会话是否正在跑（含"正在思考"）。running 是布尔值，不是 null。 */
    function readRunning(ops, sessionId) {
      const session = ops.sessionOf(sessionId)
      if (session === undefined || typeof session.getSnapshot !== 'function') return false
      const state = session.getSnapshot()
      if (state === undefined) return false
      const value = state.running
      return value === true || (typeof value === 'object' && value !== null)
    }

    function useSessionRunning(ops, sessionId) {
      const [running, setRunning] = React.useState(() => readRunning(ops, sessionId))
      React.useEffect(() => {
        const session = ops.sessionOf(sessionId)
        if (session === undefined || typeof session.subscribe !== 'function') return undefined
        const read = () => setRunning(readRunning(ops, sessionId))
        read()
        const off = session.subscribe(read)
        return () => {
          if (typeof off === 'function') off()
        }
      }, [ops, sessionId])
      return running
    }

    /** 会话事件窗口 → 纯事件数组（兼容 entry 包装）。 */
    function eventsOf(session) {
      const source = session === undefined ? undefined : session.eventSource
      const snapshot = source !== undefined && typeof source.getSnapshot === 'function' ? source.getSnapshot() : undefined
      const entries = snapshot !== undefined && Array.isArray(snapshot.entries) ? snapshot.entries : []
      const events = []
      for (const entry of entries) {
        const event = entry !== null && typeof entry === 'object' && entry.event !== undefined ? entry.event : entry
        if (event !== null && typeof event === 'object' && typeof event.seq === 'number') events.push(event)
      }
      return events
    }

    /** 这一段人话：正文 + 有没有图片/附件。 */
    function userContentOf(events, startSeq) {
      for (const event of events) {
        if (event.seq <= startSeq || event.type !== 'user/message') continue
        const data = event.data
        if (data === undefined || data.source === undefined || data.source.kind !== 'user') continue
        if (data.surfaceOp !== undefined && data.surfaceOp !== 'append') continue
        const parts = []
        let extra = 0
        for (const block of Array.isArray(data.content) ? data.content : []) {
          if (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
          else if (block !== null && typeof block === 'object') extra += 1
        }
        return { text: parts.join(''), extra }
      }
      return { text: '', extra: 0 }
    }

    function makeOps(ctx) {
      function sessionOf(sessionId) {
        const sessions = ctx.sessions
        if (sessions === undefined || typeof sessions.binding !== 'function') return undefined
        const binding = sessions.binding(sessionId)
        return binding === undefined ? undefined : binding.session
      }

      function rowOf(sessionId) {
        const sessions = ctx.sessions
        const list = sessions === undefined ? undefined : sessions.list
        const snapshot = list !== undefined && typeof list.getSnapshot === 'function' ? list.getSnapshot() : undefined
        const byId = snapshot === undefined ? undefined : snapshot.byId
        return byId === undefined ? undefined : byId[sessionId]
      }

      /**
       * 用"这一轮最后一条消息的 seq"反查这一轮：turn/start 序号、轮次号、是不是最后一轮、原话。
       * 不依赖插槽传进来的 turn（那个是对象，不是数字）。
       */
      function turnAt(sessionId, seq) {
        const session = sessionOf(sessionId)
        if (session === undefined) return { ok: false, reason: '找不到这个会话' }
        if (typeof seq !== 'number' || !Number.isFinite(seq)) return { ok: false, reason: '拿不到这一轮的位置' }
        const events = eventsOf(session)
        let startSeq
        let number
        let lastStartSeq
        for (const event of events) {
          if (event.type !== 'turn/start') continue
          if (lastStartSeq === undefined || event.seq > lastStartSeq) lastStartSeq = event.seq
          if (event.seq > seq) continue
          startSeq = event.seq
          number = event.data === undefined || typeof event.data.turn !== 'number' ? undefined : event.data.turn
        }
        if (startSeq === undefined) return { ok: false, reason: '日志里没找到这一轮的起始位置' }
        const content = userContentOf(events, startSeq)
        return {
          ok: true,
          startSeq,
          number,
          isLast: startSeq === lastStartSeq,
          text: content.text,
          extra: content.extra,
        }
      }

      async function waitBinding(sessionId, timeoutMs) {
        const deadline = Date.now() + timeoutMs
        for (;;) {
          const session = sessionOf(sessionId)
          if (session !== undefined) return session
          if (Date.now() > deadline) return undefined
          await new Promise((resolve) => setTimeout(resolve, 50))
        }
      }

      /**
       * 归档一个会话。优先走 uiWorkspace（它除了转发还会清主视图引用、通知侧栏），
       * 拿不到就退回底层的 workspaces 服务。
       */
      function archiver() {
        const ui = ctx.get('uiWorkspace')
        if (ui !== undefined && typeof ui.archiveSession === 'function') {
          return (id, options) => ui.archiveSession(id, options)
        }
        const workspaces = ctx.get('workspaces')
        if (workspaces !== undefined && typeof workspaces.archiveSession === 'function') {
          return (id, options) => workspaces.archiveSession(id, options)
        }
        return undefined
      }

      /** 新会话里"排着队还没发"的条目 id（fork 会把旧会话的排队事件一起带过来）。 */
      function queuedItemIds(session) {
        const projections = session === undefined ? undefined : session.projections
        const face = projections === undefined || typeof projections.faceOf !== 'function' ? undefined : projections.faceOf('inbox')
        const value = face === undefined || typeof face.getSnapshot !== 'function' ? undefined : face.getSnapshot()
        const ids = []
        for (const target of ['next-turn', 'next-step']) {
          const list = value === undefined || value === null ? undefined : value[target]
          for (const item of Array.isArray(list) ? list : []) {
            if (item !== null && typeof item === 'object' && typeof item.id === 'string') ids.push(item.id)
          }
        }
        return ids
      }

      /** 把继承来的排队消息删干净，避免"删掉/改完之后又自己发一遍"。 */
      async function clearQueue(session) {
        if (session === undefined || typeof session.updateQueue !== 'function') return 0
        let removed = 0
        for (const itemId of queuedItemIds(session)) {
          try {
            await session.updateQueue(itemId, { kind: 'remove' })
            removed += 1
          } catch (error) {
            // 单条删不掉不阻断
          }
        }
        return removed
      }

      /** 切在 startSeq 之前另开一支，可选地把新的话发出去，然后归档旧会话。 */
      async function rewrite(sessionId, startSeq, text) {
        const session = sessionOf(sessionId)
        if (session === undefined) throw new Error('找不到这个会话（可能已经被关闭）')
        const state = typeof session.getSnapshot === 'function' ? session.getSnapshot() : undefined
        const running = state !== undefined && (state.running === true || (typeof state.running === 'object' && state.running !== null))
        if (running) throw new Error('还在跑，先点停止再操作')
        if (typeof startSeq !== 'number' || startSeq < 0) throw new Error('没找到这一轮的起始位置')
        const boundary = startSeq - 1
        const row = rowOf(sessionId)
        const title = row === undefined ? undefined : row.title

        let childId
        if (boundary >= 0) {
          childId = await ctx.sessions.fork({ sessionId, atSeq: boundary })
        } else {
          const cwd = row === undefined ? undefined : row.cwd
          childId = await ctx.sessions.create(cwd === undefined ? {} : { cwd })
        }

        // 先把旧会话归档掉：被中断/还在收尾的会话要 stopActivity 才归档得动。
        // 归档失败就不往下走（不跳转、不发消息），避免"删不掉却多出一份复制品"。
        const archive = archiver()
        if (archive === undefined) throw new Error('这个版本的 DSH 没有归档能力，删不了')
        // 只有拿到非空标题才打删除记号：记号是 Host 半边删盘的唯一凭据，不能误打
        const canMark = typeof title === 'string' && title !== ''
        if (canMark && typeof session.rename === 'function') {
          try {
            await session.rename(`${title}\u200b`)
          } catch (error) {
            // 打不上删除记号就退化成"只归档、不删盘"
          }
        }
        try {
          await archive(sessionId, { stopActivity: true })
        } catch (error) {
          // 恢复标题，免得以后被手动归档时误当成删除目标
          if (typeof session.rename === 'function' && typeof title === 'string' && title !== '') {
            try {
              await session.rename(title)
            } catch (restoreError) {
              // 恢复不了就算了，标题里只是一个看不见的零宽空格
            }
          }
          // 把刚切出来的复制品收进归档，别留在列表里多一条
          try {
            await archive(childId, { stopActivity: true })
          } catch (childError) {
            // 收不掉也不阻断报错
          }
          const reason = error !== null && typeof error === 'object' && typeof error.message === 'string' ? error.message : String(error)
          throw new Error(`没删掉：旧对话的收尾还没结束（${reason}）。等它彻底停下来再试一次`)
        }

        const workspace = ctx.get('uiWorkspace')
        if (workspace !== undefined && typeof workspace.openSession === 'function') workspace.openSession(childId)
        const child = await waitBinding(childId, 5000)
        if (child === undefined) throw new Error('新对话没能打开')

        if (typeof title === 'string' && title !== '' && typeof child.rename === 'function') {
          try {
            await child.rename(title)
          } catch (error) {
            // 标题改不动不影响使用
          }
        }

        // fork 会把旧会话"已排队还没发"的消息一起带进新会话；先清掉，否则会一次性全发出来
        await clearQueue(child)

        const wanted = typeof text === 'string' ? text.trim() : ''
        if (wanted !== '') {
          const result = await child.prompt([{ type: 'text', text }], 'queue')
          if (result !== undefined && result.ok === false) {
            const detail = result.error === undefined ? '' : `（${result.error.code ?? 'error'}）`
            throw new Error(`消息没发出去${detail}`)
          }
        }

        return childId
      }

      return { sessionOf, turnAt, rewrite }
    }

    function PencilIcon() {
      return h('svg', { viewBox: '0 0 24 24', 'aria-hidden': 'true' },
        h('path', { d: 'M3 17.25V21h3.75L17.8 9.94l-3.75-3.75L3 17.25zm17.71-10.21a1 1 0 0 0 0-1.42l-2.34-2.33a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z' }))
    }

    function TrashIcon() {
      return h('svg', { viewBox: '0 0 24 24', 'aria-hidden': 'true' },
        h('path', { d: 'M6 19a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z' }))
    }

    function CloseIcon() {
      return h('svg', { viewBox: '0 0 24 24', 'aria-hidden': 'true' },
        h('path', { d: 'M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z' }))
    }

    function CheckIcon() {
      return h('svg', { viewBox: '0 0 24 24', 'aria-hidden': 'true' },
        h('path', { d: 'M9 16.17 4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z' }))
    }

    /** 标题里的轮次：有具体数字就用数字，没有就写"本轮对话"。 */
    function turnLabel(number) {
      return typeof number === 'number' && Number.isFinite(number) ? `第 ${number} 轮` : '本轮对话'
    }

    /** 编辑条本体：每次换一轮就重新挂载，保证输入框里一开始就是你原来的话。 */
    function EditorStripBody({ sessionId, ops, editing }) {
      const [draft, setDraft] = React.useState(editing.draft)
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState('')
      const trimmed = draft.trim()

      const close = () => {
        if (busy) return
        writeEditor(sessionId, undefined)
      }

      const submit = async () => {
        if (busy || trimmed === '') return
        setBusy(true)
        setError('')
        try {
          await ops.rewrite(sessionId, editing.startSeq, draft)
          writeEditor(sessionId, undefined)
        } catch (failure) {
          const message = failure !== null && typeof failure === 'object' && typeof failure.message === 'string' ? failure.message : String(failure)
          setError(message)
        } finally {
          setBusy(false)
        }
      }

      return h('div', { className: 'dme-strip' },
        h('div', { className: 'dme-strip-head' },
          h('span', null, `编辑中 · ${turnLabel(editing.number)}`),
          h('span', { style: { flex: '1' } }),
          h('button', {
            type: 'button',
            className: 'dme-icon',
            title: '取消（Esc）',
            'aria-label': '取消编辑',
            disabled: busy,
            onClick: close,
          }, h(CloseIcon)),
          h('button', {
            type: 'button',
            className: 'dme-icon',
            title: '发送（Ctrl+Enter）',
            'aria-label': '发送修改后的提问',
            disabled: busy || trimmed === '',
            onClick: submit,
          }, h(CheckIcon))),
        h('textarea', {
          className: 'dme-strip-input',
          value: draft,
          autoFocus: true,
          placeholder: '这一轮没有找到你的原始提问，直接输入新的也行',
          onChange: (event) => setDraft(event.target.value),
          onKeyDown: (event) => {
            if (event.key === 'Escape') close()
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) void submit()
          },
        }),
        editing.extra > 0 ? h('div', null, `原消息里还有 ${editing.extra} 个图片/附件，重发时不会带过来。`) : null,
        error === '' ? null : h('div', { className: 'dme-error' }, error),
        h('div', { className: 'dme-hint' }, '发送后会把这一轮及之后的内容切掉，用改过的话重新发（原对话会被删除，磁盘上不留）。'))
    }

    function EditorStrip({ sessionId, ops }) {
      const editing = useEditor(sessionId)
      React.useEffect(() => () => {
        writeEditor(sessionId, undefined)
      }, [sessionId])
      if (editing.value === undefined) return null
      const key = `${editing.value.startSeq}`
      return h(EditorStripBody, { key, sessionId, ops, editing: editing.value })
    }

    /** 删除前的二次确认。挂到 body，免得被聊天区的 overflow/transform 裁掉。 */
    function ConfirmDelete({ busy, error, onCancel, onConfirm }) {
      // 弹层里的按钮不一定拿到焦点，Esc 得在 document 上听
      React.useEffect(() => {
        if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') return undefined
        const onKey = (event) => {
          if (event.key === 'Escape' && !busy) onCancel()
        }
        document.addEventListener('keydown', onKey)
        return () => {
          document.removeEventListener('keydown', onKey)
        }
      }, [busy, onCancel])

      const dialog = h('div', {
        className: 'dme-backdrop',
        onMouseDown: (event) => {
          if (event.target === event.currentTarget && !busy) onCancel()
        },
        onKeyDown: (event) => {
          if (event.key === 'Escape' && !busy) onCancel()
        },
      }, h('div', { className: 'dme-dialog', role: 'alertdialog', 'aria-modal': 'true' },
        h('div', { className: 'dme-dialog-title' }, '确定要删除这段对话吗？'),
        h('div', { className: 'dme-dialog-body' }, '会把这一轮的提问和我的回答一起删掉。'),
        h('div', { className: 'dme-dialog-body', style: { fontSize: '12px' } }, '原对话会被删除，磁盘上不留备份。'),
        error === '' ? null : h('div', { className: 'dme-error', style: { textAlign: 'center' } }, error),
        h('div', { className: 'dme-row', style: { justifyContent: 'center' } },
          h('button', { type: 'button', className: 'dme-btn dme-btn-ghost', disabled: busy, onClick: onCancel }, '取消'),
          h('button', { type: 'button', className: 'dme-btn dme-btn-danger', disabled: busy, onClick: onConfirm },
            busy ? '处理中…' : '删除'))))
      if (ReactDOM === undefined || typeof ReactDOM.createPortal !== 'function' || typeof document === 'undefined') return dialog
      return ReactDOM.createPortal(dialog, document.body)
    }

    /** 每轮末尾的铅笔 + 垃圾桶（垃圾桶只在最后一轮出现）。 */
    function TurnTweak({ seq, sessionId, ops }) {
      const [confirming, setConfirming] = React.useState(false)
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState('')
      const running = useSessionRunning(ops, sessionId)
      const events = useEventRevision(ops, sessionId)
      const info = React.useMemo(() => ops.turnAt(sessionId, seq), [ops, sessionId, seq, events])

      const startEdit = React.useCallback(() => {
        // 日志还没加载全时不进编辑态：拿不到 startSeq 就切不出正确的分支
        if (info.ok !== true) return
        writeEditor(sessionId, { startSeq: info.startSeq, number: info.number, draft: info.text, extra: info.extra })
      }, [info, sessionId])

      const remove = async () => {
        setBusy(true)
        setError('')
        try {
          await ops.rewrite(sessionId, info.startSeq, undefined)
          setConfirming(false)
        } catch (failure) {
          const message = failure !== null && typeof failure === 'object' && typeof failure.message === 'string' ? failure.message : String(failure)
          setError(message)
        } finally {
          setBusy(false)
        }
      }

      if (typeof sessionId !== 'string' || sessionId === '') return null

      const canDelete = info.ok === true && info.isLast === true && !running

      return h(React.Fragment, null,
        h('div', { className: 'dme-actions' },
          h('button', {
            type: 'button',
            className: 'dme-icon',
            disabled: running || info.ok !== true,
            onClick: startEdit,
            title: running ? '还在跑，先点停止再来改' : info.ok === true ? '编辑这一轮的提问' : '这一轮的日志还没加载全',
            'aria-label': '编辑这一轮的提问',
          }, h(PencilIcon)),
          canDelete ? h('button', {
            type: 'button',
            className: 'dme-icon dme-icon-danger',
            onClick: () => {
              setError('')
              setConfirming(true)
            },
            title: '删除这段对话',
            'aria-label': '删除这段对话',
          }, h(TrashIcon)) : null),
        confirming ? h(ConfirmDelete, {
          busy,
          error,
          onCancel: () => {
            if (busy) return
            setConfirming(false)
            setError('')
          },
          onConfirm: () => {
            if (!busy) void remove()
          },
        }) : null
      )
    }

    /** 样式只注入一次（每轮都塞一个 <style> 会越积越多）。 */
    function ensureStyle() {
      if (typeof document === 'undefined') return
      if (typeof document.createElement !== 'function' || document.head === null || document.head === undefined) return
      if (typeof document.getElementById === 'function' && document.getElementById('dme-style') !== null) return
      const style = document.createElement('style')
      style.id = 'dme-style'
      style.textContent = CSS
      document.head.appendChild(style)
    }

    return {
      inject: ['slots', 'sessions'],
      apply(ctx) {
        ensureStyle()
        const ops = makeOps(ctx)
        ctx.slots.inject('conversation.chat.turnTail', () => ctx.slots.register({
          name: 'conversation.chat.turnTail',
          id: 'msg-edit-actions',
          order: 20,
          inject: (sessionId) => ({ sessionId, ops }),
        }, TurnTweak))
        ctx.slots.inject('conversation.input.overlay', () => ctx.slots.register({
          name: 'conversation.input.overlay',
          id: 'msg-edit-strip',
          order: 20,
          inject: (sessionId) => ({ sessionId, ops }),
        }, EditorStrip))
      },
    }
  },
})
