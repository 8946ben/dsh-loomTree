// 关系复核流程测试：摘要缓存 → 首轮关系 → need 原文 → 第二轮；以及增量只加新节点。
// 全部用假 fetch，不访问网络。运行：node flow-test.cjs
const fs = require('node:fs')
const vm = require('node:vm')

let checks = 0
let failures = 0
function check(name, ok, detail) {
  checks += 1
  if (!ok) {
    failures += 1
    console.error('FAIL ' + name + (detail ? ' :: ' + detail : ''))
  }
}

const src = fs
  .readFileSync(require('node:path').join(__dirname, 'client.js'), 'utf8')
  .replace(
    'return { inject, apply }',
    'return { inject, apply, __buildTree: buildTree, __driveRelations: driveRelations, __relationsStore: relationsStore, __readSummaryCache: readSummaryCache }'
  )
let loaded = null
const React = {
  createElement: () => ({}),
  useState: value => [value, () => {}],
  useEffect: () => {},
  useMemo: fn => fn(),
  useCallback: fn => fn(),
  useRef: value => ({ current: value })
}
const store = new Map()
const sandbox = {
  window: { __ModuleLoader__: { load: def => { loaded = def } } },
  document: {
    head: { appendChild() {} },
    getElementById: () => null,
    createElement: () => ({}),
    querySelector: () => null,
    querySelectorAll: () => []
  },
  localStorage: {
    getItem: key => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: key => store.delete(key)
  },
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
vm.runInContext(src, sandbox)
const probe = loaded.factory(name => (name === 'react' ? React : {}))

const user = (id, seq, text) => ({
  type: 'event',
  event: { type: 'user/message', seq, data: { id, source: { kind: 'user' }, content: [{ type: 'text', text }] } }
})
const assistant = (seq, text) => ({
  type: 'event',
  event: { type: 'assistant/message', seq, data: { message: { content: [{ type: 'text', text }] } } }
})
const long = text => text.repeat(40)
const events = [
  user('n1', 1, '扩散草稿有哪些'),
  assistant(2, long('扩散草稿的回答。')),
  user('n2', 3, '特征级自回归草稿有哪些'),
  assistant(4, long('特征级自回归的回答。')),
  user('n3', 5, 'DSpark 属于哪种'),
  assistant(6, long('DSpark 的回答。')),
  user('n4', 7, 'EAGLE-1 原理'),
  assistant(8, long('EAGLE-1 的回答。'))
]
const ruleTrees = probe.__buildTree(events)

let summaryCalls = 0
let relationCalls = 0
let detailCalls = 0
sandbox.fetch = async (url, options) => {
  const body = JSON.parse((options && options.body) || '{}')
  if (String(url).includes('/summary')) {
    summaryCalls += 1
    return { ok: true, json: async () => ({ summary: '摘要内容。'.repeat(100).slice(0, 500) }) }
  }
  if (String(url).includes('/relations')) {
    if (body.detail) {
      detailCalls += 1
      return { ok: true, json: async () => ({ parents: { n3: 'n1' }, need: [] }) }
    }
    relationCalls += 1
    if (body.fresh && body.fresh.length === 1) {
      return {
        ok: true,
        json: async () => ({ parents: { n5: 'n2' }, need: [], raw: '{"parents":{"n5":"n2"},"need":[]}' })
      }
    }
    return { ok: true, json: async () => ({ parents: {}, need: ['n3'], raw: '{"parents":{},"need":["n3"]}' }) }
  }
  throw new Error('unexpected url ' + url)
}

;(async () => {
  await probe.__driveRelations(ruleTrees, { relate: true })
  const first = JSON.stringify(probe.__relationsStore.parents)
  check('首轮应用了原文第二轮的结果', first === '{"n3":"n1"}', first)
  check('首轮 knownIds 覆盖全部节点', probe.__relationsStore.knownIds.length === 4, String(probe.__relationsStore.knownIds.length))
  check(
    '首轮摘要 4 次 / 关系 1 次 / 原文 1 次',
    summaryCalls === 4 && relationCalls === 1 && detailCalls === 1,
    [summaryCalls, relationCalls, detailCalls].join(',')
  )
  check('摘要缓存写入 4 条', Object.keys(probe.__readSummaryCache()).length === 4, String(Object.keys(probe.__readSummaryCache()).length))

  const more = [
    ...events,
    user('n5', 9, '新问题'),
    assistant(10, long('新问题的回答。'))
  ]
  await probe.__driveRelations(probe.__buildTree(more), { relate: true })
  const second = JSON.stringify(probe.__relationsStore.parents)
  check('增量复核只加新节点且保留旧结果', second === '{"n3":"n1","n5":"n2"}', second)
  check('增量 knownIds 覆盖 5 个节点', probe.__relationsStore.knownIds.length === 5, String(probe.__relationsStore.knownIds.length))
  check(
    '增量只新增 1 条摘要，不重复请求旧节点',
    summaryCalls === 5 && relationCalls === 2 && detailCalls === 1,
    [summaryCalls, relationCalls, detailCalls].join(',')
  )
  check('增量后摘要缓存 5 条', Object.keys(probe.__readSummaryCache()).length === 5, String(Object.keys(probe.__readSummaryCache()).length))

  if (failures > 0) {
    console.error('flow-test: ' + failures + '/' + checks + ' failed')
    process.exit(1)
  }
  console.log('flow-test: ' + checks + ' assertions passed')
})().catch(error => {
  console.error(error)
  process.exit(1)
})
