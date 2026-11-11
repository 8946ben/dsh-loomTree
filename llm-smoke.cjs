// 命名链路自检（不需要浏览器、不读取密钥）：
//   1) GET  /learnmap/llm.json   -> 命名能力开关与模型
//   2) POST /learnmap/labels     -> 用两条真实提问换取知识点名，打印耗时
//
// 用法：node llm-smoke.cjs [origin]
//   默认 http://127.0.0.1:53119（以当前 DSH 实际端口为准）
const origin = process.argv[2] || process.env.LEARNMAP_ORIGIN || 'http://127.0.0.1:53119'

const items = [
  { id: 'q1', text: 'EventLoop 是什么，为什么说它是单线程却高并发？', parent: '' },
  { id: 'q2', text: '那微任务呢', parent: 'EventLoop 是什么，为什么说它是单线程却高并发？' },
  { id: 'q3', text: 'TCP 三次握手为什么不是两次', parent: '' }
]

async function main() {
  const config = await fetch(`${origin}/learnmap/llm.json`).then((r) => r.json().catch(() => null))
  if (!config || config.enabled !== true) {
    console.log('命名能力未开启（宿主返回：', config, '）')
    process.exit(1)
  }
  console.log('provider :', config.provider)
  console.log('model    :', config.model)

  const started = Date.now()
  const res = await fetch(`${origin}/learnmap/labels`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ items })
  })
  const json = await res.json()
  const elapsed = ((Date.now() - started) / 1000).toFixed(1)
  console.log('http     :', res.status, ' elapsed:', elapsed + 's')
  if (json.error) console.log('error    :', json.error)
  const names = json.names || {}
  for (const item of items) console.log(`  ${item.id}: ${JSON.stringify(names[item.id] || null)}  <-  ${item.text}`)
  const ok = items.every((item) => typeof names[item.id] === 'string' && names[item.id] !== '')
  console.log(ok ? 'OK：全部命名成功' : 'WARN：存在未命名的提问')
  process.exit(ok ? 0 : 1)
}

main().catch((error) => {
  console.error('FAIL:', error && error.message ? error.message : error)
  process.exit(1)
})
