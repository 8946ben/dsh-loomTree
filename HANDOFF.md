# 学习分支图插件 · 维护者说明

> 面向继续维护 / 修改这个插件的开发者与 agent；普通使用者请看 [README](README.md)。
> 先读这一份，再动代码。**第 3 节的硬约束是踩过坑换来的，违反会直接坏功能。**
> 插件目录：仓库根目录；验证环境：DSH 0.2.x，profile `desktop`。

---

## 1. 它是什么 / 在哪运行

把当前会话的问答流程整理成知识点树，提供两个界面：

| 界面 | 挂载点 | 说明 |
| --- | --- | --- |
| 输入框上方的细条 `🌳 N节点` + 可展开缩进列表 | `conversation.input.dock`，`id: 'learnmap'`，`order: 15` | 轻量、边聊边看 |
| 右侧栏标签页「学习分支图」里的**可编辑节点图** | 标签类型 `id: '@learnmap/web-plugin/tree'`、`kind: 'learnmap'`；正文挂 keyed 槽位 `sidebar.right.pane.tab`（key 同上） | 大图、拖拽、改名、改关系 |

**分工（核心设计，别搞混）**

- **父子关系 = 纯规则**（`buildTree`：事件窗口 → 提问片段 → 术语匹配决定父节点）。
- **节点名字 = LLM**（宿主侧调用，按提问文本缓存）；失败自动退回规则标题。
- **人工编辑 = 覆盖层**（`applyEdits`：改名 / 改父 / 改位置，存 localStorage，按 `messageId`）。

```
会话事件窗口 ──buildTree──▶ 原始树 ──applyEdits──▶ 最终树 ──layoutGraph──▶ 画板
   (只读)        (规则)              (人工覆盖)        (几何)
                                   ▲
                        LLM 命名（只给 label，不动关系）
```

---

## 2. 文件与职责

```
learnmap-bundle/
├─ package.json        bundle 清单：dsh.bundle.patch + dsh.client(platform/immediately/inject)
├─ cordis.patch.yml    插入插件行 id: learnmap（**不要在这里写密钥**）
├─ index.js            宿主半区：两个只读 HTTP 路由 + 调模型 + 命名缓存（约 356 行）
├─ client.js           浏览器半区：全部 UI / 建树 / 编辑 / 画板（约 2490 行，单文件无构建）
├─ locale/{zh,en}.json 插件管理器里的标题与描述
├─ icon.svg            插件图标
├─ smoke-test.cjs      离线冒烟测试（桩 window/React/ctx），当前 116 条断言
├─ llm-smoke.cjs       命名链路自检（读路由 → 真打一次模型）
└─ README.md           现状说明（设计取值、手势、验证方式）
```

`client.js` 内部分区（按注释搜即可）：

| 分区 | 内容 |
| --- | --- |
| 1–3 | 文本/术语提取、`buildTree`（规则）、跳转 `jumpTo` |
| 3.5 | 命名：`namingStore`（模块级）、`driveNaming`、`useNaming`、`useLearnmapSession` |
| 4 | 会话事件窗口：`lookupBinding` / `useBinding` / `useEventWindow` |
| 5 | 细条面板 `LearnmapDock` / `LearnmapBody` |
| 6.4 | 编辑表：`editStore`、`applyEdits`、`flattenTree` |
| 6.5 | 画板：`layoutGraph`、`edgePath`、`graphNodeState`、`GraphBody`/`GraphSurface` |
| 6.6 | 底纹：`BOARD_*`、`boardBackground`、`boardScrimOpacity`、`shrinkImage` |
| 7 | `apply(ctx)`：注册槽位 + 侧栏标签类型 |

---

## 3. 硬约束（踩过坑，别违反）

### 3.1 宿主/client 的边界

- 本项目是**静态 bundle**，client 半区**没有** `host.call`（那是 `cordis_define` 动态包专属）。
  皮肤/逻辑要走宿主，唯一通道是：宿主 `webServer.register` 一条路由 → client `fetch` 同源相对路径。
- 页面能力只有：`ctx.get(name)` / `ctx.inject(deps, cb)` / `ctx.slots.inject/register` / `ctx.effect` /
  `React` / 相对路径 `fetch`。**没有 require、没有 Node API、不能直连外网。**

### 3.2 宿主路由必须等 `webServer` 就绪

```js
// ✅ 正确
ctx.inject(['webServer'], scope => {
  const web = scope.webServer
  ctx.effect(() => web.register({ kind: 'exact', path: '/learnmap/labels', async handler(req, res) {…} }), 'label')
})
// ❌ 错误：冷启动时插件行常常早于 web server，拿到 undefined 后永不重试
// const web = ctx.get('webServer'); if (!web) return
```

**历史事故**：用 `ctx.get` 写死，冷启动后 `/learnmap/*` 全 404，界面显示「规则命名」，命名功能整体失效，
但热重载过的会话看起来正常——极难排查。

路由约定：`kind: 'exact'`；只接受回环（`127.0.0.1` / `::1`），非回环返回 403；
`content-type: application/json`；`cache-control: no-store`；**不回传密钥**。

### 3.3 调模型在宿主，不在浏览器

这台机器的浏览器请求经过系统代理（`127.0.0.1:7897`），代理到不了模型域名；宿主进程直连可用。
所以：

- 宿主优先 `ctx.llm.stream({ provider, model, system, messages, signal })`（与聊天同一条通路）；
- `ctx.llm` 不可用时才用 `config.apiKey` 直连兜底；
- **不要在 client 里 `fetch('https://…/chat/completions')`**——会因代理失败，也等于把密钥下发到页面。

### 3.4 密钥只放 profile 补丁层

```yaml
# ~/.dsh/profiles/desktop/cordis.patch.yml
- id: learnmap
  config:
    provider: zai
    model: glm-5.3-flash
    apiKey: '…'          # 可选，仅 ctx.llm 失败时兜底
    baseUrl: https://open.bigmodel.cn/api/paas/v4
    enabled: true        # false = 退回纯规则命名
```

不要写进 `package.json` / bundle 的 `cordis.patch.yml` / 源码常量。

### 3.5 命名状态必须是**模块级 store**

`namingStore`（`labels` / `status` / `error` / `version` + 订阅）由 `useNaming()` 消费，`driveNaming(tree, config)` 驱动，
`namingInFlight`（按文本哈希）去重。**原因**：输入框面板与侧栏图会同时挂载，如果命名状态放在组件里，
一次提问会触发两次模型调用（重复付费），且两边名字不同步。

### 3.6 折叠按钮必须看「真实子节点」

`layoutGraph` 会把收起节点的 `kids` 置空（用于隐藏子树），**不能**用 `item.kids.length` 判断要不要渲染折叠按钮：

```js
const fold = graphNodeState(item.node, collapsed)   // hasKids / collapsed / hidden 都基于 node.children
// ❌ item.kids.length > 0  → 收起后按钮消失，节点再也展不开（已修，别再犯）
```

### 3.7 节点尺寸 = 文字量出来，字体必须与 CSS 完全一致

- `NODE_FONT = '500 15px …'`、`NODE_LETTER_SPACING = 0.3`，`measureText` 用同一个字体并额外加 `字数 × 0.3px`。
- 改 `.lm-gnode-label` 的 `font-size` / `font-weight` / `letter-spacing` → **必须同步改 `NODE_FONT` / `NODE_LETTER_SPACING`
  和估算回退值**（`? 15 : 8.2`）。
- 历史上「量 12px、渲染 13px」导致文字量出来偏窄、渲染时溢出一行，标题被拆成两行。
- `NODE_PAD = 82` = 左右 padding(28×2) + 折叠按钮 18 + 余量；改 padding 要同步。

### 3.8 画板用 transform 平移，不要用滚动条

侧栏面板高度常由内容撑出（`.lm-graph` 的 `height:100%` 在 auto 父级下失效），容器没有滚动溢出，
`scrollLeft` 改了没有任何效果——这是第一版"拖不动"的真实原因。现在是：

```
屏幕坐标 = 视口原点 + pan + 画板坐标 × zoom
```

- 状态：`pan {x,y}` + `zoom`，CSS `translate(pan) scale(zoom)`，视口 `overflow:hidden; position:relative`；
- 一切坐标换算走 `toCanvas()` 与 `event.delta / zoom`，**不要混用 scrollTop**；
- 手动固定坐标存 `editStore.positions[id]`（画板坐标，与 zoom 无关）。

### 3.9 手势分工（改之前先看这张表）

| 交互 | 落点 | 处理 |
| --- | --- | --- |
| 平移画板 | 左键拖空白 / 中键任意处 | `onBoardPointerDown`，`closest('[data-lm-node]')` 内不抢 |
| 拖动节点 | 左键在节点上（移动 ≥4px） | `onNodePointerDown/Move/Up` + `setPointerCapture` |
| 点击节点 | 左键在节点上（<4px） | 跳回该提问；`event.detail > 1` 时让位给双击 |
| 改父子关系 | 节点底部圆点 → 目标节点 / 空白 | `onLinkPointerDown/Move/Up` + `document.elementFromPoint` |
| 改名 | 双击节点 | 内联 input，Enter 提交 / Esc 取消 / 失焦提交 |
| 缩放 | `Ctrl`/`⌘` + 滚轮（原生 `wheel`，`passive:false`） | `zoomAt(pan, point, from, to)` 保持指针锚定 |
| 平移 | 滚轮（不按 Ctrl） | `pan - deltaX/deltaY` |
| 适宽 | `⚙` 旁 `NN%` 按钮 / 双击空白 | `fit()`，并置 `manualZoom = true` |

`manualZoom`：一旦用户手动改过缩放，自动适宽就不再干预。

### 3.10 自动适宽要等视口真的有宽度

首帧 `clientWidth` 可能为 0。用 `ResizeObserver` 校正（见 `GraphSurface` 里那段 `useEffect`），
不要用「只跑一次的 ref 标记」——会永远错过。

### 3.11 z-index / 图层顺序

```
.lm-graph-bg (z0)  ← 底图（点阵/图片）
.lm-graph-scrim (z0, DOM 在后)  ← 遮罩，压住画面保可读
.lm-graph-canvas (z1) → svg 连线 + 节点卡片
.lm-set-backdrop (z29) → .lm-graph-settings (z30)
```

### 3.12 箭头与端口

- 箭头是 SVG `<marker id="lm-graph-arrow">`，`markerUnits="userSpaceOnUse"`，`viewBox 0 0 12 12`、
  `markerWidth/Height = 12`、三角形 `M1,1 L11,6 L1,11 Z`（约 10px），`refX=11` 让**尖端正好落在子节点上边**，
  不会像 `refX=7` 那样把尖顶藏进卡片 1~2px；填色 `label-secondary`，与连线同色。
- 连线 2px、`stroke-opacity .9`；改粗细时箭头不用跟着改，marker 是独立尺寸。
- **节点顶部不要放装饰圆点**：它会正好盖住箭头落点（历史 bug，箭头"消失"就是这么来的）。
  只有底部圆点（11px，可拖，悬停 `scale(1.25)`）。

### 3.13 稳定性：任何注册都必须可失败

- 宿主 `apply` 抛错会让插件行 `failed`；client `apply` 抛错会破坏槽位树，最坏影响整个会话页。
- 所以：`apply` 里每个注册段落都 `try/catch`，缺服务时**降级跳过**（侧栏没有 `sidebarRightTabs` 就只留细条）。
- 所有资源注册走 `ctx.effect(...)` 并返回清理函数（样式表、路由、标签类型、监听器）。

### 3.14 侧栏标签页的三步注册

```js
ctx.inject(['sidebarRightTabs', 'sidebarRight'], scope => {
  ctx.effect(() => scope.sidebarRightTabs.register({
    id: '@learnmap/web-plugin/tree', kind: 'learnmap', priority: 'extension',
    title: () => '学习分支图'
  }), 'learnmap: sidebar tab type')
  ctx.slots.inject('sidebar.right.pane.tab', () =>
    ctx.slots.register({ name: 'sidebar.right.pane.tab', key: '@learnmap/web-plugin/tree' }, GraphBody))
  openSidebarGraph = () => scope.sidebarRight.openTab('learnmap')
})
```

`register` 的 `id` 会被同时用作正文槽位的 key；`id`/`kind` 冲突会抛错。

### 3.15 事件窗口是分页的：图必须自己补历史

`binding.eventSource` 只是**已加载的一页**，不是整段会话。DSH 首屏与 `loadOlder()` 都按 Turn 对齐分页
（≥50 条 `user/message` + `assistant/message`，并跨过 ≥2 个 `turn/start`）。插件只把真人提问当节点，
一个 turn 里工具消息又很多，所以长会话首屏经常只剩最近 5 个提问——这就是「进图只有 5 个节点、
要回聊天点几次『加载更早』才长全」的原因。

现在 `GraphSurface` 挂载时自动翻页，规则固定为：

```js
// 与聊天「加载更早」同一个入口，只翻页、不复制数据
await binding.session.loadOlder()
// 每页后等事件窗口发布新 revision；连续两页没进展就停
// 上限：24 页 / 45 秒；卸载时 stop，避免 setState
```

- **只在侧栏图里自动跑**，输入框细条不跑（否则每次聊天都在后台拉全量历史）。
- 必须判 `typeof session.loadOlder === 'function'`；没有就退回「只看已加载的部分」。
- 停止条件抽成纯函数 `historyPagingDone`（smoke-test 有断言），改上限就改这里 + 断言。
- 已加载过的会话 `hasMore` 会变 `false`，不会重复翻页；同一会话用 `historyRef.key` 去重。
- 副作用：聊天记录也会同步出现更早的消息，这是预期的（DSH 自己保持阅读锚点）。
- 手动入口：顶部提示条的「停止 / 继续加载」；不要再造一套自己的历史拉取。

---

## 4. 数据与持久化（改结构要同时改迁移）

| 键 | 位置 | 内容 | 边界 |
| --- | --- | --- | --- |
| `learnmap.open` | localStorage | 细条是否展开 `'1'/'0'` | — |
| `learnmap.llm.labels.v1` | localStorage | `{ [文本哈希]: 名字 }`，上限 600 | 页面侧缓存 |
| `learnmap.edits.v1` | localStorage | `{ names, parents, positions }`，键是 `messageId`，上限 600 | 人工编辑 |
| `learnmap.board.v1` | localStorage | `{ mode, dotSize, dotOpacity, image, imageOpacity, imageBlur, imageFit, imageScrim, edgeStyle }` | 画板外观（图片以 dataURL 存，已压到长边 1600） |
| `~/.dsh/storages/learnmap/labels.json` | 磁盘 | 宿主命名缓存，上限 500 | 跨重启复用，避免重复付费 |

- `readBoard()` 对未知枚举值做了回退（`mode` / `imageFit` / `edgeStyle`），**加新字段也要加回退**。
- 改 `edits` 结构要给默认值兜底；`applyEdits` 里的环检测与"父节点不存在→退回原关系"不能去掉。

---

## 5. 改完怎么验证

### 5.1 语法与测试（不需要重启 DSH）

```powershell
$env:DSH_DESKTOP_NODE_EXECUTABLE='D:\install\DeepSeek Harness\DeepSeek Harness.exe'
$env:ELECTRON_RUN_AS_NODE='1'
$n='D:\install\DeepSeek Harness\resources\runtime\bin\node.cmd'
& $n --check 'D:\test\织布机Learn\learnmap-bundle\client.js'
& $n --check 'D:\test\织布机Learn\learnmap-bundle\index.js'
& $n 'D:\test\织布机Learn\learnmap-bundle\smoke-test.cjs'      # 期望「全部通过」116 条
& $n 'D:\test\织布机Learn\learnmap-bundle\llm-smoke.cjs' 'http://127.0.0.1:<当前端口>'
```

`smoke-test.cjs` 覆盖：注册形态、建树规则、布局数学、曲线/折线两种连线几何、节点尺寸与折行、
缩放锚点、遮罩、底纹三模式、细条图标化、编辑表（改名/改父/环检测/回退）、折叠按钮回归。
**新增纯函数请顺手加断言**——这个项目没有别的自动化手段。

### 5.2 生效方式

| 改了哪 | 怎么生效 |
| --- | --- |
| `client.js` | 页面 `Ctrl+R`（客户端 bundle 在启动时加载） |
| `index.js` | `plugin_manager set_plugin target=include:learnmap enabled=false` → `true`（重新 import 模块）；或重启应用 |
| `cordis.patch.yml`（profile 里的） | 通常热重载；不生效就重载插件行 |

### 5.3 可以机器验证的东西

- 槽位：`cordis_inspect_query` 平台 `client`、provider `Slots`、`root: 'conversation.input.dock'`
  → occupants 应含 `{ id: 'learnmap', order: 15, active: true }`；
  `root: 'sidebar.right.pane.tab'` → 应含 `@learnmap/web-plugin/tree`。
- 宿主路由：`Invoke-WebRequest http://127.0.0.1:<port>/learnmap/llm.json` → 200 且**不含 apiKey**；
  `POST /learnmap/labels` body `{"items":[{"id":"x","text":"…"}]}` → 返回 `names`。
- 插件行：`plugin_manager list_plugins` → `include:learnmap` `enabled: true`、`fiberPhase: active`。

像素与手势（拖拽手感、hover、遮罩观感）**无法机器验证**，需要人看图确认。

---

## 6. 已知坑（按踩坑时间排序）

1. **会话日志被别的应用移走**：`clawd-on-desk` 会自动归档 `~/.dsh/sessions` 下"24h 前且 ≤4 轮"的会话，
   表现是打开旧对话报 `session/not-found`。恢复脚本 `..\restore-dsh-sessions.ps1`，事故记录 `..\clawd-archived-sessions-incident.md`。
   **与本插件无关**，但排查"用户说插件弄坏了会话"时先看这条。
2. **规则命名 / 路由 404**：见 3.2。
3. **折叠后展不开**：见 3.6。
4. **标题被拆成两行**：见 3.7。
5. **箭头看不见**：见 3.12。
6. **拖不动画板**：见 3.8。
7. **首次打开只看到卡片左半截**：侧栏窄 + 未自动适宽，见 3.10。
8. **命名重复扣费**：命名状态放在组件里，见 3.5。
9. **多条边互相穿插很难看**：默认 T 形垂分（`edgePath` 走 elbow 分支，母线 = 父底 + clamp(层距×45%, 14, 44)），
   曲线只作为 `⚙ → 连线 → 曲线` 的可选项。
10. **进图只看到 5 个节点 / 要回聊天点「加载更早」**：事件窗口是 Turn 对齐分页的，见 3.15；
    侧栏图现已自动补全，若又出现先查 `loadOlder` 的调用条件与 `historyPagingDone` 上限。
11. **单链也出现拐弯 / 父子左对齐**：`layoutGraph` 曾把负的 `x` 直接 clamp 到 0，
    宽父节点被推右、和窄子节点左对齐；现改为「先算真实坐标、走完整体平移到最左缘为 0」。
    改布局时别把 clamp 塞回 `nodes.push`（smoke-test 有宽父+窄子的回归断言）。

---

## 7. 修改前/后检查清单

**动手前**

- [ ] 明确改动落在哪个半区（宿主 / 浏览器），是否真的需要跨端（能客户端算就别加路由）。
- [ ] 触碰 `buildTree` / `applyEdits` / `layoutGraph` 前，先跑一遍 smoke-test 记住基线。
- [ ] 触碰样式前先确认：改的是「普通模式」还是「图片底图模式」（后者有 `.lm-graph-image` 覆盖规则）。
- [ ] 改 `localStorage` 结构 → 想好旧数据的回退。

**提交前**

- [ ] `node --check` 两个入口文件。
- [ ] `smoke-test.cjs` 全绿；新增纯函数有断言。
- [ ] 界面改动：`Slots.listSubTree` 里占用者仍在且 `active: true`。
- [ ] 宿主改动：两个路由 200，且 `llm.json` 不回传密钥。
- [ ] 没有把密钥写进 bundle、没有把模型调用搬到浏览器、没有在 `apply` 里裸抛异常。
- [ ] 更新 `README.md`（设计取值、手势表）与本文件的相关条目。

---

## 8. 不要做

- ❌ 手改 profile 的 `package.json` / 直接 pnpm（安装走 `plugin_manager install_bundle`）。
- ❌ 用 `ctx.get('webServer')` 判断可用性（改成 `ctx.inject`）。
- ❌ 在 client 里直连模型端点或任何外网域名。
- ❌ 用 typert remote / `host.call` 做 bundle 内通信（本版本 bundle 面没有这条通道）。
- ❌ 用滚动条、DOM 估算布局、`document.body.appendChild` 造第二套 UI。
- ❌ 把命名/编辑状态放到组件内部（会重复扣费、两个面板不同步）。
- ❌ 在 `apply` 里假设服务一定存在而不 `try/catch`。

---

需要更细的实现细节时，按顺序看：`README.md`（现状与取值）→ `client.js` 分区注释 →
`smoke-test.cjs`（每个纯函数的用法即契约）→ 运行时用 `cordis_inspect_query` 看真实槽位/props。
