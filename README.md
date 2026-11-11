# 学习分支图 · 临时插件（@learnmap/web-plugin 0.2.x）

把当前会话的问答流程整理成知识点树，常驻在**输入框上方**（`conversation.input.dock`），
点击节点跳回对应提问。这是旧版「学习分支图」（Typert Remote + `details` 右栏）针对
DeepSeek Harness **0.2.1-rc.3 / desktop profile** 的重写版。

**分工：父子关系用规则算，节点名字用 LLM 起。** 规则决定的树形不动，只把「标题」换成
模型给的完整知识点名。

## 为什么重写

| 旧版（0.1.x, profiles/web） | 本版（0.2.x, profiles/desktop） |
| --- | --- |
| Host 半区 `TypertRemoteService` + `sessionQuery.readSession` 全量重建 | 树在浏览器半区算：订阅读 `ctx.get('sessions').binding(id).eventSource`（会话事件窗口） |
| 客户端 `ctx.remote.$mount(CONTRIBUTION)` 自挂 typert 描述符 | 该机制已不属于 bundle 面（只剩 `cordis_define` 动态包的 `host.call`），整段删除 |
| 面板挂 `details` 槽 + `ctx.layout.openDetails()` | `details` 槽已不存在；改用 `conversation.input.dock`（list/session，`replaceRisk: none`） |
| — | 插件改为 **bundle**：`dsh.bundle.patch` + `dsh.client`，由 `install_bundle` 安装 |

## 结构

- `index.js` — Host 半区：注册两个只读回环路由，`/learnmap/llm.json`（命名能力开关）
  与 `/learnmap/labels`（调 LLM 起名 + 缓存）。
- `client.js` — 浏览器半区：注册两个挂载点、事件窗口 → 知识点树、规则关系、点击跳转、
  样式、命名结果的合并与本地缓存。
- `cordis.patch.yml` — 插入 `id: learnmap` 的插件行。
- `locale/{zh,en}.json` + `icon.svg` — 插件管理器的标题、描述与图标。
- `smoke-test.cjs` — 离线冒烟测试（桩 window/React/ctx，验证注册、建树、布局、渲染）。
- `llm-smoke.cjs` — 命名链路自检（读宿主路由 → 打真实请求 → 打印名字与耗时）。

## 两个界面

| 挂载点 | 形态 | 用途 |
| --- | --- | --- |
| `conversation.input.dock` | 输入框上方一条细条 `🌳 N节点`；右侧全是**纯图标按钮**（打开侧栏图 / 全部展开 / 全部收起，各带 `title` 与 `aria-label`），展开是缩进列表 | 边聊边看、单步跳转；不遮挡对话 |
| `sidebar.right.pane.tab` + `sidebarRightTabs` | 右侧栏标签页「学习分支图」里的**树状节点图** | 复杂会话：一屏看全貌、按分支收放、点击定位 |

树状图是静态 SVG + 绝对定位节点：叶子按顺序占列、父节点居中于子节点上方；缩放（`−` / `适宽` / `+`）
用 CSS transform，无图形库依赖。输入框细条右侧的图标打开这张图（`sidebarRight.openTab('learnmap')`）。

连线默认是**T 形垂分**：父节点底边中点竖直下落 → 圆角水平母线 → 竖直进入子节点上边中点。
母线落在父节点下方约 45% 层距（夹在 14–44px），同层兄弟共用一条；因为父节点居中于子节点跨度之上，
母线天然左右对称。**单链（只有一个子节点）退化成一条纯竖线，零拐点。**

⚙ →「连线」可切到**曲线**（`C` 控制点竖直方向、`c` 夹 16–96px），喜欢柔和手感的人用。

> 之前箭头看不见，是因为节点顶部那颗 7px 装饰圆点正好压在箭头落点上；参考稿只有底部端口，
> 所以顶部装饰桩已删除，箭头现在直接落在「节点上边框 + 底部端口」之间。

线宽 2px、`stroke-opacity .9`、色 `label-secondary`（图片底图同色同宽），
另叠一层 4.5px `bg-base` 软底压住花背景；箭头是 12px marker 里的 10px 实心三角，
`refX=11` 让尖端正好落在子节点上边，不会藏进卡片里。
方向感与「浅灰细线 + 母线」的做法参考了公开的树形编辑器视觉规范
（[DingFlow 视觉规范](https://raw.gitcode.com/canonical-entropy/nop-chaos-flux/raw/ui-review/docs/architecture/flow-designer/dingflow-visual-spec.md)：
卡片轻投影、连线色 `#cacaca`、点阵 `gap 20 / size 1`）。

### 卡片与连线（按参考稿定稿）

参考稿的关键取值，逐一落到了 token 上：

| 项 | 参考稿 | 本插件 |
| --- | --- | --- |
| 卡片底 | `rgba(255,255,255,.88)` + `blur(8px)` | `color-mix(bg-layer-1 78%, transparent)` + `backdrop-filter: blur(10px) saturate(1.04)`（再透明一档，压在照片上会透出底图） |
| 卡片边 | `1.5px solid #cbd5e1` | `1.5px solid color-mix(label-secondary 32%, border-l2)`（比纯浅边更实，缩小后也看得见） |
| 圆角 / 内边距 | `10px` / `13px 28px` | `11px` / 标签左右各 28px，卡片高 48 |
| 字 | `15px / 500 / letter-spacing .3px` | 同（量宽用的 canvas 字体也带 0.3px 字距，避免"量小了就折行"） |
| 阴影 | `0 4px 12px rgba(15,23,42,.06)` | `0 5px 16px rgba(15,23,42,.10)` + `inset 0 1px 0 rgba(255,255,255,.32)` 内高光 |
| 端口 | `11px`、`2px #64748b` 边、悬停 `scale(1.25)` + 填充 | 同 |
| 层间距 / 分支间距 | `56px` / `48px` | `GAP_Y = 56`、`GAP_X = 48` |
| 连线 | `#64748b` + 白色光晕描边 | `label-secondary` 1.6px @90% + 4.5px `bg-base` 光晕 @60% |

层级对齐沿用"父节点居中于子节点跨度之上"，所以单链就是一条正竖线（没有多余拐弯）；
分叉时走 T 形垂分（默认折线，⚙ 可切曲线）。

### 早期版本的另一套「毛玻璃 + 微光」外观（已弃用）

参考了另一份流式节点图设定稿（玻璃卡片 + 双层发光连线 + 上下连接桩），按本插件主题 token 重做：

| 元素 | 做法 |
| --- | --- |
| 卡片 | `14px` 圆角；`color-mix(bg-layer-1 82%, transparent)` 半透明底 + `backdrop-filter: blur(12px) saturate(1.08)`；`border-l2` 55% 描边；`0 6px 18px -6px rgba(0,10,30,.28)` 外投影 + `inset 0 1px 0 rgba(255,255,255,.35)` 内高光 |
| 当前节点 | 品牌色 14% 混入底 + 1.5px 品牌描边环 + `0 0 20px` 品牌微光 |
| 连线 | 三层：`bg-base` 6px/35% 软底 → 品牌 4.5px/16% 微光 → `border-l2` 1.4px 实线；图片模式微光 5px/24%、实线 `label-secondary`/82% |
| 连接桩 | 顶部 7px 装饰桩（有父节点时出现，60%）；底部 10px 可拖桩（品牌描边 + 微光，常显 55%），悬停补满 |
| 字号 | 标题 13px / 17.5px 行高 / 字重 500；根节点 600 |

卡片半透明 + 模糊是关键：压在自定义照片上时卡片会「吸」一点背景色，比纯白卡片自然得多。
`color-mix` 与 `backdrop-filter` 在 Electron 44（Chromium 140+）可用；不支持时自动退化成主题实色。

叶子节点留 18px 占位，保证同级标题右端对齐；折叠按钮默认隐去、悬停节点时淡入（收起态常显），
这样卡片右缘保持干净，和参考图一致，功能也没有丢。

### 长会话：打开图时自动补全更早的问答

DSH 的会话事件窗口是**分页**的：首屏（以及聊天里每一次「加载更早」）至少取 50 条
`user/message` + `assistant/message`，并向前跨过至少两个 `turn/start`。一个 turn 里工具消息很多，
所以一页往往只覆盖最近 5 个提问；插件只把「真人提问」当节点，于是刚打开侧栏图时只看到 5 个节点。

现在侧栏图挂载时会自动调用 `binding.session.loadOlder()`（与聊天「加载更早」同一个入口）逐页往前翻，
直到事件窗口 `hasMore === false`，节点图一次就是完整的。保护措施：

| 项 | 取值 |
| --- | --- |
| 上限 | 24 页 / 45 秒，先到先停 |
| 卡住判定 | 连续两页都没拿到新 `revision` 就停下 |
| 手动控制 | 顶部提示条可「停止」；没补完时可「继续加载」 |
| 副作用 | 聊天记录也会一并出现更早的消息（DSH 自己保持阅读锚点）；不自动跑在输入框细条里，避免每次聊天都拉全量历史 |

> 只翻页、不复制数据：仍是同一份 `SessionEventWindow`，所以跳转、折叠、人工编辑都不受影响。

### 画板底纹（⚙ 设置）
底纹画在**铺满视口的独立图层**上（`.lm-graph-bg`，`position:absolute; inset:0`），
不是画在节点画布上——所以永远覆盖整个空间，空的地方也有。点阵跟着 `pan/zoom` 走
（`background-position = pan`，`background-size = dotSize × zoom`），拖动画板时底纹一起移动。

| 模式 | 说明 |
| --- | --- |
| 点阵 | 密度 细/中/粗（14/18/26px），深浅 0.06–0.6 可调 |
| 纯色 | 无底纹，只留主题背景 |
| 图片 | 选任意图片：自动压到长边 1600px 的 JPEG 存进 localStorage；**遮罩 0–0.95**、透明度 0.05–1、模糊 0–12px、铺满/平铺 |

设置存在 `localStorage['learnmap.board.v1']`（`{ mode, dotSize, dotOpacity, image, imageOpacity, imageBlur, imageFit }`），
点顶栏 `⚙` 打开，点面板外任意处关闭。图片带模糊时图层外扩 24px，避免边缘被糊掉。

**图片来源有三条入口**，都走同一个处理函数（类型校验 → 压到长边 1600px JPEG → 存本机）：

1. `选择图片` 按钮 → `<input type="file">`；
2. **把图片拖进画板**（dragover 高亮 + 居中提示「松开：设为画板底图」）；
3. 复制图片后 **Ctrl+V**（仅当焦点不在输入框/编辑器里，避免抢聊天框的粘贴）。

> 2026-11-11 排障：`accept="image/*"` 在这台机器的系统「打开」对话框里会被判成「文件名无效」，
> 所以改成显式扩展名（`.png,.jpg,.jpeg,.webp,.gif` + MIME），并补了拖入/粘贴两条不依赖对话框的入口。

`选择图片` 的文件输入还改成了「视觉隐藏但可点击」（`opacity:0` + 1px），
避免 `display:none` 的 input 在某些 Electron 版本里点不开对话框。

节点尺寸**随文字走**：用 canvas 量显示名的真实字宽，宽度 = 文字宽 + 内边距（下限 132、
上限 420），只有超过上限才折成 2–3 行并加高；层高取该层最高节点，画布按实际盒子撑开。
名字因此不再被省略号截断（英文按窄字宽、中日韩按全角估算；测不到 canvas 时退化成估算）。

### 画板编辑（自动分类分错时可以自己掰回来）

| 手势 | 效果 |
| --- | --- |
| 左键拖空白处 | 平移整个画板（`cursor: grab` / 拖动时 `grabbing`） |
| 中键拖任意处 | 平移画板（节点上也可，不会误拖节点） |
| 滚轮 | 平移画板（`deltaX` / `deltaY` 直接换算成位移） |
| `Ctrl`（或 `⌘`）+ 滚轮 | 缩放 0.3×–1.8×，以指针为锚点（`zoomAt`，缩放前后指针下的画板点不动） |
| 双击空白 | 适宽并归位到左上角 |
| 拖动节点 | 固定该节点坐标（后续不再参与自动排布），边跟着走 |
| 双击节点 | 就地改名，Enter 提交、Esc 取消 |
| 拖节点底部圆点 → 另一个节点 | 把它改挂到目标节点下 |
| 拖节点底部圆点 → 空白处 | 提为根节点 |
| `重排` | 清掉手动坐标，回到自动布局 |
| `还原` | 清掉本会话的改名与关系改写 |

**为什么不用滚动条平移**：侧栏面板的高度常常是内容撑出来的，容器不会产生滚动溢出，
`scrollLeft` 改了也没有任何效果（这正是第一版平移「拖不动」的原因）。现在改成
`translate(pan) + scale(zoom)` 的画板坐标变换：视口 `overflow:hidden`，位移与缩放都不依赖
布局是否溢出，节点/连线/拖拽坐标全部换算在同一套 `(pan, zoom)` 里。

手势互不抢：节点上的 pointerdown 由节点自己捕获，画板处理器只认「落点不在
`[data-lm-node]` 内」的左键按下；中键在节点上也归画板；连线圆点在 pointerdown 阶段就
`stopPropagation`。

编辑表存在 localStorage（`learnmap.edits.v1`），节点 id 是消息 id（全局唯一），所以
跨会话、刷新后都还在：

```js
{ names: { [messageId]: '自定义名字' },
  parents: { [messageId]: parentId | 'root' },
  positions: { [messageId]: { x, y } } }
```

两条硬约束：

- **成环的改写会被忽略**（把节点拖到自己的子孙下），退回原关系而不是把树弄坏；
- **父节点已不存在**（比如被压缩掉）时同样退回原关系，节点不会凭空变成根。

编辑是模块级 store，输入框上方那份列表会同步显示改名后的标题（内容斜体表示是手改过的）。

### 侧栏标签页是怎么接进来的

右侧栏是标签页系统，插件侧只需要三步（都在 `client.js` 的 `apply` 里）：

```js
ctx.inject(['sidebarRightTabs', 'sidebarRight'], scope => {
  // 1) 注册一个 tab 类型（id 会被用作正文槽位的 key）
  ctx.effect(() => scope.sidebarRightTabs.register({
    id: '@learnmap/web-plugin/tree', kind: 'learnmap', priority: 'extension',
    title: () => '学习分支图'
  }), 'learnmap: sidebar tab type')
  // 2) 正文挂在 keyed 槽位，键 = 类型 id
  ctx.slots.inject('sidebar.right.pane.tab', () =>
    ctx.slots.register({ name: 'sidebar.right.pane.tab', key: '@learnmap/web-plugin/tree' }, GraphBody))
  // 3) 打开它
  openSidebarGraph = () => scope.sidebarRight.openTab('learnmap')
})
```

缺 `sidebarRightTabs` / `sidebarRight` 任一服务时整段跳过，只保留输入框上方那份（降级不报错）。
### 图片底图下的可读性

花底图会吃掉细线与箭头，所以图片模式多两层处理：

1. **遮罩层**（`.lm-graph-scrim`，`background: bg-base`，默认 0.55，可在 ⚙ 里调）压在底图与画布之间，
   把画面朝主题方向压淡，文字卡片与线条都回到可读对比度；
2. **连线双层描边**：先画一层 4.5px 的 `bg-base` 光晕（`.lm-graph-halo`），再画 1.5px 的实线，
   箭头三角也带 `bg-base` 外描边；图片模式再加深一档（线色 `label-primary`、线宽 1.6、光晕 5px），
   节点卡片同时换成更实的投影（`.lm-graph-image .lm-gnode`）。

点阵/纯色模式不受影响（遮罩为 0，光晕与背景同色，视觉上等于没有）。

## 命名为什么放在宿主

这台机器的浏览器请求走系统代理（`127.0.0.1:7897`），而该代理到不了模型端点；
宿主进程直连可用（和聊天同一条通路）。所以：

- 页面只访问 `127.0.0.1`（ProxyOverride 命中，不过代理、无 CORS、无密钥暴露）；
- 密钥与模型调用留在宿主，页面只从 `/learnmap/llm.json` 拿到 `{ enabled, provider, model }`。

宿主优先用 `ctx.llm.stream({ provider, model, ... })`（即 profile 里已配置的 zai 通路）；
`ctx.llm` 不可用时才用 `config.apiKey` 直连兜底。两条路都失败则退回规则标题，
面板显示「命名失败」（悬浮可看原因），树本身不受影响。

## 命名规则

- 触发：树变化后 700ms 防抖；只请求**还没有名字**的节点（一次最多 40 条，宿主每批 8 条）。
- 提示词要点：6–18 字、完整名词短语、英文专名保留并补中文语义、不带提问语气、
  承接上文的半句要带上 `parent` 主题（如「EventLoop 微任务」）。
- 缓存三层：页面 `localStorage`（按提问文本哈希）→ 宿主内存 → `~/.dsh/storages/learnmap/labels.json`
  （跨重启复用，避免重复付费）。
- 关闭：profile 补丁层里给该行 `config.enabled: false`，或删掉 `apiKey`，
  面板自动退回规则命名。

## 数据与跳转

- 节点只取 `user/message` 且 `source.kind === 'user'`、`surfaceOp` 为 `append`（真人提问）。
- 后续 `assistant/message` 正文累积到最近节点，供术语关联打分。
- 父节点：命中提问术语的最近段落 → 否则线性挂上一段；`回到最初` 挂根。
- 跳转：`[data-chat-flow-key]` / `[data-chat-node-key]` 精确/后缀匹配 → 否则按提问文本
  在 `[data-chat-flow-kind="user"]` 里兜底 → 都不中时用 `binding.session.loadThrough(seq)`
  加载历史后重试，命中再 `scrollIntoView` + 闪光。

## 配置

用户自己的 profile 补丁层（`~/.dsh/profiles/desktop/cordis.patch.yml`）：

```yaml
- id: learnmap
  config:
    provider: zai              # ctx.llm 的 provider 路由
    model: glm-5.3-flash
    apiKey: '...'              # 可选：ctx.llm 不可用时的直连兜底
    baseUrl: https://open.bigmodel.cn/api/paas/v4
```

## 安装 / 卸载

仓库根目录就是可安装的 bundle（`package.json` 里带 `dsh.bundle.patch`）：

```
git clone https://github.com/8946ben/dsh-loomTree.git
# 安装：target 指向克隆下来的目录
plugin_manager install_bundle  target=<本仓库目录>
# 卸载
plugin_manager remove_bundle   target=@learnmap/web-plugin
```

改 `client.js` 只需在页面 `Ctrl+R`；改 `index.js`（宿主半区）需要重载插件行
（`plugin_manager set_plugin include:learnmap` 关→开）让模块重新导入。

## 验证

- `GET /learnmap/llm.json` → `{"enabled":true,"provider":"zai","model":"glm-5.3-flash"}`。
- `POST /learnmap/labels` 用两条真实提问 → 返回
  `{"names":{"q1":"EventLoop 事件循环单线程高并发原理","q2":"EventLoop 微任务机制"}}`，
  约 2s，并写入 `~/.dsh/storages/learnmap/labels.json`。
- `smoke-test.cjs` → 116 项全部通过（含布局数学、文字宽度与折行、编辑表改名/改关系/环检测/回退、折叠按钮回归、补全历史的分页上限）。
- 冷启动注意：路由必须用 `ctx.inject(['webServer'], …)` 注册。插件行常常早于 web server 激活，
  只查一次 `ctx.get('webServer')` 会拿到 undefined 并永久放弃（表现为面板显示「规则命名」、
  `/learnmap/*` 全 404）——这是 2026-11-11 修掉的真实故障。
- 像素级渲染与页面内手势未经机器验证（本环境无法控制浏览器），需人工确认。
