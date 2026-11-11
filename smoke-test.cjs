// 学习分支图 bundle · 离线冒烟测试
// 用桩 window/React/ctx 加载 client.js，验证：
//   1) 模块以包名为 id 注册工厂，工厂返回 { inject, apply }；
//   2) apply 只注册 conversation.input.dock 一个槽位条目；
//   3) 树构建（buildTree）在真实事件形状上给出正确的父子关系；
//   4) 组件能渲染且不抛错（用最小 React 桩做一次渲染）。
const fs = require('fs')
const path = require('path')
const vm = require('vm')

const here = __dirname
const failures = []
function check(name, ok, detail) {
  if (ok) console.log('  ok   ' + name)
  else {
    console.log('  FAIL ' + name + (detail ? ' — ' + detail : ''))
    failures.push(name)
  }
}

// ---- 最小 React 桩 ----
const React = {
  createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
  useMemo: (fn) => fn(),
  useCallback: (fn) => fn,
  useRef: (value) => ({ current: value })
}

// ---- 最小 document / localStorage 桩 ----
const styles = []
const documentStub = {
  head: { appendChild: (el) => styles.push(el) },
  getElementById: (id) => styles.find((s) => s.id === id) || null,
  createElement: () => ({ id: '', textContent: '', setAttribute() {}, remove() {} }),
  querySelector: () => null,
  querySelectorAll: () => []
}
const storage = new Map()
const localStorageStub = {
  getItem: (k) => (storage.has(k) ? storage.get(k) : null),
  setItem: (k, v) => storage.set(k, String(v))
}

// ---- 捕获 __ModuleLoader__.load ----
let loaded = null
const windowStub = { __ModuleLoader__: { load: (def) => { loaded = def } } }

const source = fs.readFileSync(path.join(here, 'client.js'), 'utf8')
const sandbox = {
  window: windowStub,
  document: documentStub,
  localStorage: localStorageStub,
  console,
  setTimeout,
  clearTimeout,
  Promise,
  Math,
  JSON,
  Object,
  Array,
  String,
  Number,
  Set,
  Map
}
sandbox.globalThis = sandbox
vm.createContext(sandbox)
vm.runInContext(source, sandbox, { filename: 'client.js' })

check('模块以包名注册', loaded !== null && loaded.id === '@learnmap/web-plugin', loaded && loaded.id)

const plugin = loaded.factory((name) => {
  if (name === 'react') return React
  throw new Error('unexpected require: ' + name)
})
check('工厂返回 inject/apply', Array.isArray(plugin.inject) && typeof plugin.apply === 'function')
check('inject 含 slots', plugin.inject.indexOf('slots') >= 0, JSON.stringify(plugin.inject))

// ---- ctx 桩 ----
const registrations = []
let injectedNames = null
let tabRegistrations = []
let openedKinds = []
const fakeSessions = { binding: () => undefined }
const fakeTabs = {
  register: (definition) => {
    tabRegistrations.push(definition)
    return () => {}
  }
}
const fakeRight = {
  openTab: (kind) => {
    openedKinds.push(kind)
  }
}
const ctx = {
  get: (name) => (name === 'sessions' ? fakeSessions : undefined),
  inject: (names, callback) => {
    injectedNames = names
    callback({ sidebarRightTabs: fakeTabs, sidebarRight: fakeRight })
    return () => {}
  },
  effect: (fn) => {
    const dispose = fn()
    return typeof dispose === 'function' ? dispose : () => {}
  },
  slots: {
    inject: (name, callback) => {
      callback()
      return () => {}
    },
    register: (options, component) => {
      registrations.push({ options, component })
      return () => {}
    }
  }
}
plugin.apply(ctx)
check('样式表已插入', styles.length === 1)
check('注册了两个条目（输入框 dock + 侧栏图正文）', registrations.length === 2, String(registrations.length))
check('注入了侧栏服务', Array.isArray(injectedNames) && injectedNames.indexOf('sidebarRightTabs') >= 0, JSON.stringify(injectedNames))
check('注册了一个侧栏标签类型', tabRegistrations.length === 1, String(tabRegistrations.length))
if (tabRegistrations.length === 1) {
  const tab = tabRegistrations[0]
  check('标签类型 kind 为 learnmap', tab.kind === 'learnmap', tab.kind)
  check('标签类型带 id', typeof tab.id === 'string' && tab.id !== '')
  check('标签标题是函数', typeof tab.title === 'function' && tab.title() === '学习分支图')
}
const dockEntry = registrations.find((entry) => entry.options.name === 'conversation.input.dock')
const graphEntry = registrations.find((entry) => entry.options.name === 'sidebar.right.pane.tab')
check('dock 条目的槽位名正确', dockEntry && dockEntry.options.id === 'learnmap')
check('侧栏图正文槽位正确', graphEntry && graphEntry.options.key === '@learnmap/web-plugin/tree', graphEntry && graphEntry.options.key)
check('两个条目都提供组件函数', !!dockEntry && typeof dockEntry.component === 'function' && !!graphEntry && typeof graphEntry.component === 'function')

if (dockEntry) {
  const { options, component } = dockEntry
  check('label 是函数', typeof options.label === 'function')

  // ---- 一次渲染：无 sessionId 时返回 null；有 sessionId 时渲染出标题栏 ----
  const empty = component({ sessionId: '', useSession: () => ({}) })
  check('无会话 id 时渲染 null', empty === null)
  // 桩 createElement 只造元素、不执行组件，这里手工下钻一层再断言。
  const outer = component({ sessionId: 'session-1', useSession: (sel) => sel({ nodes: [] }), session: null })
  const vnode = outer && typeof outer.type === 'function' ? outer.type(outer.props) : outer
  check('渲染出根节点', vnode && vnode.props && vnode.props.className === 'lm-root', vnode && vnode.props && vnode.props.className)
  const bar = vnode && vnode.children ? vnode.children[0] : null
  const barJson = JSON.stringify(bar)
  check('标题栏 aria-label 保留「学习分支图」', barJson.indexOf('学习分支图') >= 0)
  check('标题栏只显示节点数（空树为「暂无节点」）', barJson.indexOf('暂无节点') >= 0)
  check('标题栏不再渲染 11px 的独立计数样式', barJson.indexOf('lm-count') < 0)
  check('标题栏带「打开侧栏图」图标入口', barJson.indexOf('在右侧栏打开树状图') >= 0 && barJson.indexOf('lm-ico') >= 0)
}

// ---- 侧栏图正文渲染：给一个有内容的 binding，走一遍真实渲染路径 ----
if (graphEntry) {
  const entries = [1, 2, 3, 4].map((i) => ({
    type: 'event',
    event: {
      type: 'user/message',
      seq: i * 10,
      time: i,
      data: { id: 'g' + i, source: { kind: 'user' }, content: [{ type: 'text', text: '第' + i + '个提问 EventLoop 分支 ' + i }] }
    }
  }))
  const bindingStub = {
    sessionId: 'session-g',
    session: { loadThrough: async () => {} },
    eventSource: { getSnapshot: () => ({ entries, hasMore: false, revision: 1 }), subscribe: () => () => {} }
  }
  fakeSessions.binding = () => bindingStub

  const graphOuter = graphEntry.component({ sessionId: 'session-g', useSession: (sel) => sel({}), session: null })
  const surface = graphOuter && typeof graphOuter.type === 'function' ? graphOuter.type(graphOuter.props) : graphOuter
  check('侧栏图渲染出根容器', surface && surface.props && surface.props.className === 'lm-graph', surface && surface.props && surface.props.className)
  const surfaceJson = JSON.stringify(surface)
  check('侧栏图渲染出滚动画布', surfaceJson.indexOf('lm-graph-scroll') >= 0)
  check('侧栏图渲染出节点', surfaceJson.indexOf('data-lm-node') >= 0)
  check('侧栏图渲染出连线', surfaceJson.indexOf('lm-graph-edges') >= 0)
  check('侧栏图带手势提示', surfaceJson.indexOf('拖节点改位置') >= 0 && surfaceJson.indexOf('Ctrl+滚轮缩放') >= 0)
  check('侧栏图带重排/仅规则按钮', surfaceJson.indexOf('重排') >= 0 && surfaceJson.indexOf('仅规则') >= 0)
  check('连线带方向箭头', surfaceJson.indexOf('lm-graph-arrow') >= 0 && surfaceJson.indexOf('markerEnd') >= 0)
  check('画板底纹层铺满视口', surfaceJson.indexOf('lm-graph-bg') >= 0)
  check('画板有遮罩层', surfaceJson.indexOf('lm-graph-scrim') >= 0)
  check('连线有描边光晕', surfaceJson.indexOf('lm-graph-halo') >= 0)
  check('顶栏有外观设置入口', surfaceJson.indexOf('画板外观设置') >= 0 && surfaceJson.indexOf('⚙') >= 0)
  check('顶栏显示缩放百分比', surfaceJson.indexOf('%') >= 0)

  // 画板平移：滚动容器上必须挂 pointer 手势，且调用不炸
  const findVnode = (vnode, predicate) => {
    if (!vnode || typeof vnode !== 'object') return null
    if (Array.isArray(vnode)) {
      for (const child of vnode) {
        const hit = findVnode(child, predicate)
        if (hit) return hit
      }
      return null
    }
    if (predicate(vnode)) return vnode
    for (const child of vnode.children || []) {
      const hit = findVnode(child, predicate)
      if (hit) return hit
    }
    return null
  }
  const scrollNode = findVnode(surface, (node) => node && node.props && typeof node.props.className === 'string' && node.props.className.indexOf('lm-graph-scroll') >= 0)
  check('找到画板滚动容器', !!scrollNode)
  if (scrollNode) {
    const props = scrollNode.props
    check(
      '画板容器挂上平移手势',
      typeof props.onPointerDown === 'function' && typeof props.onPointerMove === 'function' && typeof props.onPointerUp === 'function'
    )
    check('平移/缩放提示写在底部', surfaceJson.indexOf('中键平移') >= 0 && surfaceJson.indexOf('Ctrl+滚轮缩放') >= 0)
    let threw = null
    try {
      props.onPointerDown({ button: 0, target: { closest: () => null }, currentTarget: { setPointerCapture() {} }, clientX: 10, clientY: 10, pointerId: 1 })
      props.onPointerMove({ clientX: 40, clientY: 30 })
      props.onPointerUp({})
    } catch (error) {
      threw = error
    }
    check('平移回调可直接调用', threw === null, threw && threw.message)

    const inputNode = findVnode(surface, (node) => node && node.props && typeof node.props.accept === 'string')
    check('文件输入带明确扩展名', !!inputNode && inputNode.props.accept.indexOf('.png') >= 0 && inputNode.props.accept.indexOf('image/jpeg') >= 0, inputNode && inputNode.props.accept)
    check('画板支持拖入图片', typeof props.onDrop === 'function' && typeof props.onDragOver === 'function' && typeof props.onDragLeave === 'function')
  }
  const nodeCount = entries.length
  check('渲染节点数与树一致', (surfaceJson.match(/"data-lm-node"/g) || []).length === nodeCount, String((surfaceJson.match(/"data-lm-node"/g) || []).length))
  // 细条工具：展开状态下应只有图标（aria-label 仍保留中文）
  storage.set('learnmap.open', '1')
  const dockBound = dockEntry.component({ sessionId: 'session-g', useSession: (sel) => sel({}), session: null })
  const dockBody = dockBound && typeof dockBound.type === 'function' ? dockBound.type(dockBound.props) : dockBound
  const dockBar = dockBody && dockBody.children ? dockBody.children[0] : null
  const dockJson = JSON.stringify(dockBar)
  const iconCount = (dockJson.match(/"lm-ico"/g) || []).length
  check('细条工具全部改成图标', iconCount >= 3, String(iconCount))
  check('图标保留中文 aria-label', dockJson.indexOf('全部展开') >= 0 && dockJson.indexOf('全部收起') >= 0)
  storage.delete('learnmap.open')

  fakeSessions.binding = () => undefined
}

// ---- 树构建：直接调用内部 buildTree（通过重新执行并注入探针）----
// 把 buildTree / layoutGraph 暴露出来做断言：在源码尾部临时追加导出。
const probeSource = source.replace(
  'return { inject, apply }',
  'return { inject, apply, __buildTree: buildTree, __layoutGraph: layoutGraph, __applyEdits: applyEdits, __applyLlmParents: applyLlmParents, __relationSignature: relationSignature, __relationChanges: relationChanges, __relationAnswerBudget: relationAnswerBudget, __canAdoptChild: canAdoptChild, __graphNodeState: graphNodeState, __nodeBox: nodeBox, __zoomAt: zoomAt, __boardBackground: boardBackground, __readBoard: readBoard, __boardScrim: boardScrimOpacity, __edgePath: edgePath, __historyPagingDone: historyPagingDone }'
)
loaded = null
vm.runInContext(probeSource, sandbox, { filename: 'client-probe.js' })
const probe = loaded.factory((name) => (name === 'react' ? React : {}))
const buildTree = probe.__buildTree
check('探针可取到 buildTree', typeof buildTree === 'function')

const events = [
  { type: 'event', event: { type: 'user/message', seq: 1, time: 1, data: { id: 'm1', source: { kind: 'user' }, content: [{ type: 'text', text: '请介绍一下 EventLoop 是什么' }] } } },
  { type: 'event', event: { type: 'assistant/message', seq: 2, time: 2, data: { message: { content: [{ type: 'text', text: 'EventLoop 是事件循环……' }] } } } },
  { type: 'event', event: { type: 'user/message', seq: 3, time: 3, data: { id: 'm2', source: { kind: 'user' }, content: [{ type: 'text', text: '那 EventLoop 的微任务呢' }] } } },
  { type: 'event', event: { type: 'user/message', seq: 4, time: 4, data: { id: 'm3', source: { kind: 'user' }, content: [{ type: 'text', text: '完全无关的新问题：光合作用' }] } } },
  { type: 'event', event: { type: 'user/message', seq: 5, time: 5, data: { id: 'm4', source: { kind: 'tool' }, content: [{ type: 'text', text: '工具注入的消息不算节点' }] } } }
]
const tree = buildTree(events)
check('节点数只统计真人提问', tree.count === 3, String(tree.count))
check('最新节点是 m3', tree.latestId === 'm3', tree.latestId)
const m1 = tree.roots.find((n) => n.id === 'm1')
const m2 = tree.roots.find((n) => n.id === 'm2')
check('m1 是根节点', Array.isArray(m1 && m1.children))
check('m2 挂在 m1 下（术语命中）', m1 && m1.children.some((n) => n.id === 'm2'), JSON.stringify(tree.roots.map((n) => [n.id, n.children.map((c) => c.id)])))

// ---- 侧栏图布局：叶子占列、父节点居中、折叠隐藏子树 ----
const layoutGraph = probe.__layoutGraph
check('探针可取到 layoutGraph', typeof layoutGraph === 'function')
if (typeof layoutGraph === 'function') {
  const layout = layoutGraph(tree.roots, {})
  check('布局节点数与树一致', layout.nodes.length === tree.count, String(layout.nodes.length))
  check('每个可见分支都有一条连线', layout.pairs.length === tree.count - tree.roots.length, String(layout.pairs.length))
  const m1At = layout.nodes.find((item) => item.node.id === 'm1')
  const m2At = layout.nodes.find((item) => item.node.id === 'm2')
  check('子节点在父节点下方', !!m1At && !!m2At && m2At.y > m1At.y)
  check('父节点横向居中于唯一子节点', !!m1At && !!m2At && Math.abs(m1At.x - m2At.x) < 0.001)
  check('布局尺寸为正', layout.width > 0 && layout.height > 0)

  // Ctrl+滚轮缩放的锚点数学：缩放前后指针下的画板点必须不动
  const zoomAt = probe.__zoomAt
  check('探针可取到 zoomAt', typeof zoomAt === 'function')
  if (typeof zoomAt === 'function') {
    const point = { x: 120, y: 80 }
    const startPan = { x: 16, y: 16 }
    const next = zoomAt(startPan, point, 1, 1.5)
    const before = { x: (point.x - startPan.x) / 1, y: (point.y - startPan.y) / 1 }
    const after = { x: (point.x - next.x) / 1.5, y: (point.y - next.y) / 1.5 }
    check('缩放锚点保持不动', Math.abs(before.x - after.x) < 0.001 && Math.abs(before.y - after.y) < 0.001, JSON.stringify([before, after]))
    const same = zoomAt(startPan, point, 1, 1)
    check('缩放比不变时位移不变', same.x === startPan.x && same.y === startPan.y)
  }

  // 底纹样式：点阵随缩放放大、图片走 opacity/blur、纯色无底图
  const boardBackground = probe.__boardBackground
  check('探针可取到 boardBackground', typeof boardBackground === 'function')
  if (typeof boardBackground === 'function') {
    const dots = boardBackground({ mode: 'dots', dotSize: 18, dotOpacity: 0.24 }, 2, { x: 10, y: 20 })
    check('点阵尺寸随缩放变化', dots.backgroundSize === '36px 36px', dots.backgroundSize)
    check('点阵跟随平移', dots.backgroundPosition === '10px 20px', dots.backgroundPosition)
    check('点阵是 repeat 铺满', dots.backgroundRepeat === 'repeat')
    const plain = boardBackground({ mode: 'plain' }, 1, { x: 0, y: 0 })
    check('纯色模式没有底图', plain.backgroundImage === 'none')
    const image = boardBackground({ mode: 'image', image: 'data:image/jpeg;base64,AAA', imageOpacity: 0.4, imageBlur: 6, imageFit: 'cover' }, 1, { x: 0, y: 0 })
    check('图片底纹带透明度与模糊', image.opacity === '0.4' && image.filter === 'blur(6px)', JSON.stringify(image))
    check('图片默认铺满', image.backgroundSize === 'cover' && image.backgroundRepeat === 'no-repeat')
    const tiled = boardBackground({ mode: 'image', image: 'x', imageFit: 'tile' }, 1, { x: 0, y: 0 })
    check('图片可平铺', tiled.backgroundRepeat === 'repeat' && tiled.backgroundSize === 'auto')
    const missing = boardBackground({ mode: 'image', image: '' }, 1, { x: 0, y: 0 })
    check('没选图时不留空图', missing.backgroundImage === 'none')

    // 遮罩：只在图片模式生效，范围 0–0.95
    const boardScrim = probe.__boardScrim
    check('探针可取到 boardScrimOpacity', typeof boardScrim === 'function')
    if (typeof boardScrim === 'function') {
      check('图片模式默认遮罩 0.55', boardScrim({ mode: 'image', image: 'x' }) === 0.55, String(boardScrim({ mode: 'image', image: 'x' })))
      check('点阵模式没有遮罩', boardScrim({ mode: 'dots' }) === 0)
      check('遮罩可调到 0', boardScrim({ mode: 'image', imageScrim: 0 }) === 0)
      check('遮罩上限 0.95', boardScrim({ mode: 'image', imageScrim: 5 }) === 0.95, String(boardScrim({ mode: 'image', imageScrim: 5 })))
    }
  }

  // 用一个确定形状的合成树验证布局数学（不受建树启发式影响）
  const leaf = (id) => ({ id, label: id, text: id, children: [] })
  const synthetic = [{ id: 'a', label: 'a', text: 'a', children: [leaf('b'), leaf('c')] }]
  const shaped = layoutGraph(synthetic, {})
  const a = shaped.nodes.find((item) => item.node.id === 'a')
  const b = shaped.nodes.find((item) => item.node.id === 'b')
  const cc = shaped.nodes.find((item) => item.node.id === 'c')
  check('两个叶子各占一列', !!b && !!cc && cc.x - b.x > 100, JSON.stringify([b && b.x, cc && cc.x]))
  check('父节点居中于两个子节点之间', !!a && !!b && !!cc && Math.abs(a.x - (b.x + cc.x) / 2) < 0.001, JSON.stringify([a && a.x]))
  check('合成树连线数为 2', shaped.pairs.length === 2, String(shaped.pairs.length))

  // 回归：宽父 + 窄子的单链。最左缘以前被 clamp 到 0，父节点被推右，父子左对齐后
  // 连线会在中间拐一下；应当整体平移、保持中心对齐。
  const chainRoots = [
    {
      id: 'w1',
      label: 'w1',
      text: 'w1',
      children: [{ id: 'w2', label: 'w2', text: 'w2', children: [{ id: 'w3', label: 'w3', text: 'w3', children: [] }] }]
    }
  ]
  const chainBoxes = new Map([
    ['w1', { w: 500, h: 48 }],
    ['w2', { w: 500, h: 48 }],
    ['w3', { w: 420, h: 48 }]
  ])
  const chain = layoutGraph(chainRoots, {}, chainBoxes)
  const w1 = chain.nodes.find((item) => item.node.id === 'w1')
  const w2 = chain.nodes.find((item) => item.node.id === 'w2')
  const w3 = chain.nodes.find((item) => item.node.id === 'w3')
  const centerOf = (item) => item.x + item.w / 2
  check('宽父 + 窄子的单链父子中心对齐', !!w1 && !!w2 && Math.abs(centerOf(w1) - centerOf(w2)) < 0.001, JSON.stringify([w1 && centerOf(w1), w2 && centerOf(w2)]))
  check('不同宽度的孙节点也与父中心对齐', !!w2 && !!w3 && Math.abs(centerOf(w2) - centerOf(w3)) < 0.001, JSON.stringify([w2 && centerOf(w2), w3 && centerOf(w3)]))
  check('布局整体平移后最左缘为 0', chain.nodes.every((item) => item.x >= 0) && Math.min(...chain.nodes.map((item) => item.x)) === 0, JSON.stringify(chain.nodes.map((item) => item.x)))
  check('平移后画布宽度仍覆盖最右缘', Math.abs(chain.width - Math.max(...chain.nodes.map((item) => item.x + item.w))) < 0.001, String(chain.width))

  // LLM 关系修正：只接受指向更早节点的修改，root 表示提为顶层
  const applyLlmParents = probe.__applyLlmParents
  check('探针可取到 applyLlmParents', typeof applyLlmParents === 'function')
  if (typeof applyLlmParents === 'function') {
    const ruleChain = {
      roots: [
        {
          id: 'r1',
          seq: 1,
          text: '投机解码有哪些',
          label: '投机解码',
          children: [
            {
              id: 'r2',
              seq: 2,
              text: '扩散草稿有哪些类型',
              label: '扩散草稿',
              children: [{ id: 'r3', seq: 3, text: '特征级自回归草稿有哪些', label: '特征级自回归草稿', children: [] }]
            }
          ]
        }
      ],
      count: 3,
      latestId: 'r3'
    }
    const same = applyLlmParents(ruleChain, {})
    check('没有修正建议时原样返回', same === ruleChain)

    const moved = applyLlmParents(ruleChain, { r3: 'r1' })
    const movedRoot = moved.roots[0]
    const movedIds = (movedRoot.children || []).map((node) => node.id)
    check('LLM 可把叶子节点改挂到更早的父节点', movedIds.length === 2 && movedIds.indexOf('r2') >= 0 && movedIds.indexOf('r3') >= 0, JSON.stringify(movedIds))
    check('修正后节点数与最新节点不变', moved.count === 3 && moved.latestId === 'r3')

    const detached = applyLlmParents(ruleChain, { r3: 'root' })
    check('root 建议会把叶子节点提为顶层', detached.roots.some((node) => node.id === 'r3'), JSON.stringify(detached.roots.map((node) => node.id)))

    // 根节点保护：顶层主题不允许被搬到别的节点下（历史事故是根节点被搬走）
    const rootMove = applyLlmParents(ruleChain, { r1: 'r2' })
    check('根节点不会被自动搬走', rootMove === ruleChain)

    // 非根节点可以带着子树移动（例如把“特征级”整枝挂到“投机解码”下）
    const branchMove = applyLlmParents(ruleChain, { r2: 'root' })
    check('非根节点可以提为顶层（带子树一起走）', branchMove.roots.some((node) => node.id === 'r2') && branchMove.roots.find((node) => node.id === 'r2').children.some((node) => node.id === 'r3'), JSON.stringify(branchMove.roots.map((node) => node.id)))

    // 允许挂到「更晚」的节点（知识树按主题，不按提问时间）
    const laterRoots = {
      roots: [
        { id: 'a0', seq: 0, text: '根主题', label: '根', children: [{ id: 'a1', seq: 1, text: '先问的问题', label: '先问', children: [] }] },
        { id: 'a2', seq: 2, text: '后问的总览', label: '总览', children: [] }
      ],
      count: 3,
      latestId: 'a2'
    }
    const crossTime = applyLlmParents(laterRoots, { a1: 'a2' })
    const crossParent = crossTime.roots.find((node) => node.id === 'a2')
    check('可以挂到更晚的父节点', !!crossParent && crossParent.children.some((node) => node.id === 'a1'), JSON.stringify(crossTime.roots.map((node) => node.id)))

    const missing = applyLlmParents(ruleChain, { r3: 'nope' })
    check('指向不存在节点的建议被忽略', missing === ruleChain)

    const signature = probe.__relationSignature
    check('探针可取到 relationSignature', typeof signature === 'function')
    if (typeof signature === 'function') {
      const first = signature(ruleChain)
      const again = signature({ ...ruleChain, roots: JSON.parse(JSON.stringify(ruleChain.roots)) })
      check('节点集合相同则签名稳定', first === again)
    }

    // 只把真正改变父节点的条目算作「已校正」，模型回写原 parent 时徽标不应亮
    const relationChanges = probe.__relationChanges
    check('探针可取到 relationChanges', typeof relationChanges === 'function')
    if (typeof relationChanges === 'function') {
      check('原样回写不产生变更', Object.keys(relationChanges(ruleChain, { r2: 'r1', r3: 'r2' })).length === 0, JSON.stringify(relationChanges(ruleChain, { r2: 'r1', r3: 'r2' })))
      const changed = relationChanges(ruleChain, { r3: 'r1' })
      check('真正改挂会被记录', changed.r3 === 'r1' && Object.keys(changed).length === 1, JSON.stringify(changed))
      check('不存在的 id 不计入变更', Object.keys(relationChanges(ruleChain, { nope: 'r1' })).length === 0)
    }

    // 回答节选预算：小会话近全文，大会话按总预算自动收缩
    const relationAnswerBudget = probe.__relationAnswerBudget
    check('探针可取到 relationAnswerBudget', typeof relationAnswerBudget === 'function')
    if (typeof relationAnswerBudget === 'function') {
      check('5 个节点给到单节点上限 4000', relationAnswerBudget(5) === 4000, String(relationAnswerBudget(5)))
      check('20 个节点按总预算收缩', relationAnswerBudget(20) === 1200, String(relationAnswerBudget(20)))
      check('80 个节点收缩到 300', relationAnswerBudget(80) === 300, String(relationAnswerBudget(80)))
    }

    // 连线方向：从 A 的输出拖到 B，是把 B 挂到 A 下；只拒绝自己/祖先造成的环
    const canAdoptChild = probe.__canAdoptChild
    check('探针可取到 canAdoptChild', typeof canAdoptChild === 'function')
    if (typeof canAdoptChild === 'function') {
      const adoptTree = [{ id: 'p', children: [{ id: 'c', children: [{ id: 'g', children: [] }] }] }]
      check('可以把孙节点直接挂到父节点下', canAdoptChild(adoptTree, 'p', 'g') === true)
      check('不能把祖先挂到自己的子孙下', canAdoptChild(adoptTree, 'g', 'p') === false)
      check('不能挂到自己', canAdoptChild(adoptTree, 'p', 'p') === false)
      check('不存在的目标节点不允许', canAdoptChild(adoptTree, 'p', 'nope') === false)
    }
  }


  const foldedSynthetic = layoutGraph(synthetic, { a: true })
  check('折叠后只剩父节点', foldedSynthetic.nodes.length === 1, String(foldedSynthetic.nodes.length))
  check('折叠后没有连线', foldedSynthetic.pairs.length === 0, String(foldedSynthetic.pairs.length))

  // 回归：收起后折叠按钮必须仍在（用真实子节点判断，不能用可见 kids）
  const graphNodeState = probe.__graphNodeState
  check('探针可取到 graphNodeState', typeof graphNodeState === 'function')

  // 节点尺寸随文字走：名字越长节点越宽，超过上限才折行加高
  const nodeBox = probe.__nodeBox
  check('探针可取到 nodeBox', typeof nodeBox === 'function')
  if (typeof nodeBox === 'function') {
    const tiny = nodeBox('短')
    check('短名字用最小宽度单行', tiny.w === 160 && tiny.lines === 1 && tiny.h === 48, JSON.stringify(tiny))
    const mid = nodeBox('一二三四五六七八九十')
    check('名字变长节点变宽', mid.w > tiny.w && mid.lines === 1, JSON.stringify(mid))
    const long = nodeBox('很长的一个知识点名字'.repeat(6))
    check('超长名字折行加高而不超出上限', long.w === 560 && long.lines >= 2 && long.h > 48, JSON.stringify(long))
    const latin = nodeBox('EventLoop microtask ordering explained')
    check('英文按较窄字宽估算', latin.w < 560, JSON.stringify(latin))

    // 布局要尊重各自的宽度：两个不同宽度的叶子不能叠在一起
    const wideLeaves = [
      { id: 'p', label: 'p', text: 'p', children: [
        { id: 'x1', label: 'x1', text: 'x1', children: [] },
        { id: 'x2', label: 'x2', text: 'x2', children: [] }
      ] }
    ]
    const boxed = new Map()
    for (const node of wideLeaves[0].children) boxed.set(node.id, { w: 300, h: 34, lines: 1 })
    boxed.set('p', { w: 200, h: 34, lines: 1 })
    const wideLayout = layoutGraph(wideLeaves, {}, boxed)
    const p1 = wideLayout.nodes.find((item) => item.node.id === 'x1')
    const p2 = wideLayout.nodes.find((item) => item.node.id === 'x2')
    check('宽节点按自身宽度排开', !!p1 && !!p2 && p2.x >= p1.x + p1.w + 20 - 0.001, JSON.stringify([p1 && p1.x, p2 && p2.x]))
    check('画布宽度随最宽节点增长', wideLayout.width >= p2.x + p2.w, String(wideLayout.width))
  }

  if (typeof graphNodeState === 'function') {
    const nodeA = synthetic[0]
    const foldedState = graphNodeState(nodeA, { a: true })
    check('收起后仍认为有子节点', foldedState.hasKids === true, String(foldedState.hasKids))
    check('收起后标记为已收起', foldedState.collapsed === true)
    check('收起后提示隐藏了几个分支', foldedState.hidden === 2, String(foldedState.hidden))
    const openState = graphNodeState(nodeA, {})
    check('展开时 hidden 为 0', openState.hidden === 0 && openState.hasKids === true)
    const leafState = graphNodeState({ id: 'leaf', children: [] }, {})
    check('叶子节点没有折叠按钮', leafState.hasKids === false)
    // 布局里收起节点的可见 kids 为空，但真实 children 仍在 —— 这正是原 bug 的成因
    const foldedItem = foldedSynthetic.nodes.find((item) => item.node.id === 'a')
    check('布局清空可见 kids 但保留真实 children', !!foldedItem && foldedItem.kids.length === 0 && foldedItem.node.children.length === 2)
  }
}

// ---- 肘形连线：同 x 直线、异 x 走圆角母线、终点落在子节点上边中点 ----
const edgePath = probe.__edgePath
check('探针可取到 edgePath', typeof edgePath === 'function')
if (typeof edgePath === 'function') {
  const straight = edgePath({ x: 100, y: 0, w: 200, h: 34 }, { x: 100, y: 120, w: 200, h: 34 })
  check('单链走直线', !straight.includes('Q') && straight === 'M200,34 L200,120', straight)

  // 正下方：两种样式都退化成一条竖线
  const aligned = edgePath({ x: 0, y: 0, w: 200, h: 34 }, { x: 70, y: 120, w: 60, h: 34 })
  check('正下方是竖线', !aligned.includes('Q') && !aligned.includes('C') && aligned === 'M100,34 L100,120', aligned)

  // 默认是 T 形垂分：从父节点底边中点竖直下落，母线水平，再竖直进入子节点
  const elbow = edgePath({ x: 0, y: 0, w: 200, h: 34 }, { x: 400, y: 120, w: 200, h: 34 })
  check('默认是 T 形垂分', elbow.includes('Q') && elbow.startsWith('M100,34'), elbow)
  check('T 形终点落在子节点上边中点', elbow.endsWith('L500,120'), elbow)
  const busY = Number((elbow.match(/Q100,(\d+)/) || [])[1])
  check('母线在父节点下方 14–44px', busY >= 48 && busY <= 78, String(busY))

  // 曲线是可选样式：只用 C，没有直角拐点
  const curve = edgePath({ x: 0, y: 0, w: 200, h: 34 }, { x: 400, y: 120, w: 200, h: 34 }, 'curve')
  check('曲线样式只用 C', curve.startsWith('M100,34 C') && !curve.includes('Q'), curve)
  check('曲线终点落在子节点上边中点', curve.endsWith('500,120'), curve)
}

// ---- 补全历史：分页终止条件（页数 / 耗时 / 卡住 / 用户停止）----
const historyPagingDone = probe.__historyPagingDone
check('探针可取到 historyPagingDone', typeof historyPagingDone === 'function')
if (typeof historyPagingDone === 'function') {
  const base = { hasMore: true, stop: false, pages: 0, stalls: 0, startedAt: 1000, now: 1500, maxPages: 24, maxMs: 45000 }
  check('还有更早的页时继续翻', historyPagingDone(base).done === false)
  check('历史读完后停止', historyPagingDone({ ...base, hasMore: false }).reason === 'complete')
  check('用户点停止后不再翻页', historyPagingDone({ ...base, stop: true }).reason === 'stopped')
  check('达到页数上限后停止', historyPagingDone({ ...base, pages: 24 }).reason === 'pages')
  check('超过时间预算后停止', historyPagingDone({ ...base, now: 46000 }).reason === 'time')
  check('连续两页无进展时判为卡住', historyPagingDone({ ...base, stalls: 2 }).reason === 'stalled')
  check('单页无进展还允许再试一次', historyPagingDone({ ...base, stalls: 1 }).done === false)
}
// ---- 手动编辑：改名 / 改父子关系 / 环检测 ----
const applyEdits = probe.__applyEdits
check('探针可取到 applyEdits', typeof applyEdits === 'function')
if (typeof applyEdits === 'function') {
  const same = applyEdits(tree, { names: {}, parents: {} })
  check('没有编辑时原样返回同一棵树', same === tree)

  const renamed = applyEdits(tree, { names: { m1: '自定义名字' }, parents: {} })
  const renamedNode = flatten(renamed).find((node) => node.id === 'm1')
  check('改名压过规则标题', renamedNode && renamedNode.label === '自定义名字' && renamedNode.custom === '自定义名字', renamedNode && renamedNode.label)

  // m3 原本挂在 m2 下（无术语 → 线性链），把它提为根
  const detached = applyEdits(tree, { names: {}, parents: { m3: 'root' } })
  check('提为根后出现在 roots', detached.roots.some((node) => node.id === 'm3'), JSON.stringify(detached.roots.map((n) => n.id)))
  check('提为根后不再是别人的子节点', flatten(detached).filter((node) => node.id === 'm3').length === 1)

  // 把 m2 挂到 m3 下（m3 是 m2 的子节点，属于反向成环，应被忽略）
  const cyclic = applyEdits(tree, { names: {}, parents: { m2: 'm3' } })
  const cyclicM2 = flatten(cyclic).find((node) => node.id === 'm2')
  check('成环的改写被忽略', !!cyclicM2 && !!findParentOf(cyclic, 'm2') && findParentOf(cyclic, 'm2').id === 'm1', findParentOf(cyclic, 'm2') && findParentOf(cyclic, 'm2').id)

  // 挂到一个不存在的父节点上 → 退回原始规则关系（不把节点弄丢、也不误提到根）
  const orphan = applyEdits(tree, { names: {}, parents: { m2: 'nope' } })
  const orphanParent = findParentOf(orphan, 'm2')
  check('父节点不存在时退回原关系', !!orphanParent && orphanParent.id === 'm1', orphanParent && orphanParent.id)
  check('退回后节点总数不变', flatten(orphan).length === tree.count, String(flatten(orphan).length))
}

/** 摊平成节点数组。 */
function flatten(root) {
  const out = []
  const walk = (nodes) => {
    for (const node of nodes) {
      out.push(node)
      walk(node.children || [])
    }
  }
  walk(root.roots)
  return out
}

/** 找某节点的父节点。 */
function findParentOf(root, id) {
  let found = null
  const walk = (nodes, parent) => {
    for (const node of nodes) {
      if (node.id === id) found = parent
      walk(node.children || [], node)
    }
  }
  walk(root.roots, null)
  return found
}

console.log(failures.length === 0 ? '\n全部通过' : '\n失败 ' + failures.length + ' 项: ' + failures.join(', '))
if (failures.length > 0) process.exit(1)
