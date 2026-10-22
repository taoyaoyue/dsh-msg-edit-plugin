# dsh-msg-edit

给 **DeepSeek Harness**（DSH）桌面版加两个对话操作：**改这一轮的提问**、**删掉这一段对话**。

交互照 Cherry Studio：每轮回答末尾两个小图标。点铅笔，输入框上方出现「编辑中」条并预填你原来的提问；点垃圾桶，弹「确定要删除这段对话吗？」二次确认。

- 不改 `app.asar`，不动 DSH 安装目录，只作为一个本地插件挂在 profile 里。
- 会话日志是 append-only 的，所以"原地改"实际是**在这一轮之前切一支新会话**，你看到的就是同一个对话接着往下走。

## 功能

| 按钮 | 作用 |
|---|---|
| **铅笔** · 编辑这一轮的提问 | 输入框上方出现「编辑中 · 第 N 轮」条，**预填你原来的提问**。确认后：切在这一轮之前 → 用改过的话重发 → 自动跳过去 |
| **垃圾桶** · 删除这段对话 | 把这一轮的提问和回答一起删掉。**只在最后一轮出现**，避免连带删掉后面的内容；有二次确认 |

会话正在跑（含"正在思考"）时：垃圾桶不出现，铅笔禁用，避免在生成中途切分支。

另外，**回合已经结束、但后台子 agent / 后台任务 / 定时提醒还在跑**时，删除和编辑也会被拒绝：插件不会替你停掉它们（旧版本会，代价是正在跑的子 agent 被一起 cancel），而是把「谁在跑」列出来让你等。

## 安装

需要 DSH 桌面版已经能正常运行（本插件在 `0.2.1-rc.2` 上开发并测试）。

1. **关掉 DSH。**
2. 把整个 `dsh-msg-edit` 文件夹复制到 profile 的本地插件目录：

   ```
   <DSH_HOME>/profiles/<profile>/node_modules/@local/dsh-msg-edit/
   ```

   - Windows 的 `<DSH_HOME>` 默认是 `%USERPROFILE%\.dsh`，macOS / Linux 是 `~/.dsh`
   - `<profile>` 默认是 `desktop`（桌面版就是它）
   - 复制完应该能看到 `.../@local/dsh-msg-edit/package.json`
   - `.git/`、测试脚本、README 都可以不复制；跑起来只要 `package.json` + `index.js` + `client.js` + `cordis.patch.yml` 四个文件

3. 编辑 `<profile>/cordis.patch.yml`，在文件**末尾**追加三行（注意缩进，`insert` 是顶层数组的一项）：

   ```yaml
   - insert:
       - id: msg-edit
         name: "@local/dsh-msg-edit"
   ```

4. 启动 DSH。随便开一个对话问一句，回答末尾应该出现铅笔。

> **升级/装插件前先备份这个目录。** 用「设置 → 插件」装别的插件时如果跑了 `pnpm install`，`node_modules/@local` 下没写进 profile `package.json` 的目录可能被当作 extraneous 清掉，届时把它拷回来即可。

## 用法

- **改**：点这一轮末尾的铅笔 → 输入框上方出现编辑条，里面是你原来的话 → 改成新的 → 点勾（或 `Ctrl+Enter`）。`Esc` 取消。
- **删**：点最后一轮末尾的垃圾桶 → 确认。这一轮的提问和回答都会消失，后面的内容本来就不存在（它就在最后一轮）。

删除是**真删**：旧会话先被归档，Host 半边每 5 分钟扫一次「已归档且标题带删除记号」的会话，把会话目录和投影缓存从磁盘删掉，并往 `<DSH_HOME>/msg-edit-purge.log` 记一行。**磁盘上不留备份**，想留着就先别点。

## 原理

DSH 的会话日志 append-only、永不改写（`dsh-session-persistence`：events are contiguous from seq 0 and never rewritten），转录只渲染 `surfaceOp: 'append'` 的事件。所以没有"改掉已经写进去的那条消息"的正规途径。

插件走的是官方已有的 `session.fork({ sessionId, atSeq })`：

1. 从日志里找到第 N 轮的 `turn/start`，边界取它前一个 seq（= 第 N-1 轮的结尾）；
2. `fork` 出一份"到边界为止"的新会话（前缀完全相同）；
3. 旧会话：标题末尾加一对零宽连接符（U+200C U+200D）当删除记号 → 归档（优先走 `uiWorkspace.archiveSession`，它会顺带清主视图引用）；
4. 新会话：标题改成和旧的一样 → 打开它 → 清掉 fork 带过来的"排队未发"消息 → （编辑时）把改过的话发出去。

第 1 轮没有"上一轮结尾"可切，此时用 `sessions.create()` 开新会话，同样归档旧的。

> 模型不复制。旧会话如果临时切过模型，新会话用的是 **profile 的默认模型**——不是"复制失败"，而是故意的：DSH 唯一能改会话模型的 `selectModel` 会**顺带把 profile 默认模型也改掉**（`agentDefaultModel.saveSelection`），调它会让之后所有新会话都被这次编辑带跑。详见下面的已知限制。

删除记号的清扫由 `index.js`（Host 半边）做，它只删**同时满足**下面条件的目录：

- 会话在 `workspaceRegistry.archivedSessionIds` 里（已归档）；
- 标题以 U+200C U+200D 结尾；
- 目录名与 sessionId 完全相等，且确实在 `<DSH_HOME>/sessions/<bucket>/` 下面；
- 目录里确实有 `session.*` 日志文件。

四条不满足就不动（跳过的会写进 purge 日志）。删目录的同时，`storages/session_projcache/sessions/<id>.json*`（含 `.bak`）也一起清掉。

## 已知限制

- **只能"从这一轮往后全删"**，不能单独删中间一条消息 —— 这是 append-only 架构决定的，不是实现取舍。
- 删除/编辑后是**新的 session id**：标题和历史看着一样，但内部是新会话（所以"分享链接""按 id 引用"之类会变）。
- 编辑重发**不会带原来的图片/附件**（编辑条会提示原消息里有几个）。
- **新会话不继承旧会话临时选的模型/思考等级**，会回到 profile 默认（原因见上面"模型不复制"）。
- **删完要重启才彻底干净**：磁盘上的会话文件 5 分钟内会被清掉，但 DSH 运行期还攥着那条会话的记录，「已归档」里可能留一个打不开的条目；重启后它就没了。
- 依赖 DSH 内部 API（`session.fork`、`archiveSession`、插槽 `conversation.chat.turnTail` 等）。**DSH 大版本升级后可能失效**，失效表现通常是按钮不出现或点了报错，不会损坏数据。
- 只做过 `0.2.1-rc.2` 的实测；其他版本没验证。

- **有工作在跑时删不掉**：回合、后台子 agent、后台任务、定时提醒任一项在跑，归档都会被 DSH 拒绝（报错里会列出是谁在跑）。这是故意的——旧版本用 `stopActivity: true` 强行归档，会把正在跑的子 agent 一起杀掉。

## 开发与自测

两个离线测试，都不需要 DSH 在跑：

```powershell
node smoke.mjs .        # 浏览器侧：假 React + 假 ctx 直接加载 client.js
node purge-smoke.mjs    # Host 侧：在临时 DSH_HOME 里造假会话目录，验证删/不删的判定
```

`smoke.mjs` 覆盖接线、轮次反查、原话预填、按钮显隐、二次确认、fork 边界、重发内容、归档失败回滚、在跑时拦截。
`purge-smoke.mjs` 覆盖四条判定：只有「已归档 + 标题带零宽空格 + 目录里确有 `session.*` 日志」都成立才删，少一条都不动；成功时投影缓存一起清掉。

两个都打印 `OK` 结尾（`SMOKE OK` / `PURGE OK`）就算通过；也可以直接 `npm test`。

## 卸载

1. 删掉 `cordis.patch.yml` 末尾那段 `- insert: ...`；
2. 删掉 `node_modules/@local/dsh-msg-edit/`；
3. 重启 DSH。

## 镜像同步（Gitee → GitHub）

- **主仓库在 Gitee**：<https://gitee.com/peach_moon/dsh-msg-edit-plugin>，日常改代码往这里推。
- **GitHub 是只读镜像**：<https://github.com/taoyaoyue/dsh-msg-edit-plugin>，由 [`.github/workflows/mirror-from-gitee.yml`](.github/workflows/mirror-from-gitee.yml) 每天 UTC 00:00（北京时间 08:00）整份强推过去。
- 想立刻同步：GitHub 仓库 → **Actions** → 左侧「从 Gitee 镜像同步」→ **Run workflow**。
- 用的是 Actions 自带的 `GITHUB_TOKEN`，**不需要配任何 Secret**。Gitee 仓库将来要是转私有，再到 GitHub 加 `GITEE_USER` / `GITEE_TOKEN` 两个 Secret 即可（workflow 里已经预留）。
- **别直接在 GitHub 上改文件** —— 下一次同步会被 Gitee 的内容覆盖。

## 更新记录

### 1.0.1（2026-10-23）

- **修掉「删/改一轮消息会把正在跑的子 agent 一起杀掉」**：归档旧会话时不再传 `stopActivity: true`。该参数在 DSH 里是「先停掉这个会话的回合、后台子 agent、后台任务和定时提醒再归档」，实测 2026-10-22 23:47:59 一次编辑把两个后台子 agent 以 `{kind:"parent"}` cancel 掉了。现在改为不带参数归档：有工作在跑时 DSH 会以 `workspace/session-active` 拒绝，插件把 activity 里的回合 / 子 agent / 后台任务 / 定时提醒列出来，等你处理完再来。
- **修掉「删盘从来没生效」**：删除记号从 U+200B 换成 U+200C U+200D。DSH 的标题归一化会把 U+200B（以及 U+FEFF、方向控制符）从标题里删掉，记号存不进去，Host 半边的 `title.endsWith(MARK)` 永远为假，于是「删除」实际上只归档、不删盘。
- `smoke.mjs` 新增用例：归档被拒时必须报出「谁在跑」、恢复标题、且不带 `stopActivity`。

## License

MIT，见 [LICENSE](LICENSE)。
