// 学习分支图 · Host 半区（0.2.x）。
//
// 分工：
//   - 父子关系 —— 浏览器半区的规则算，宿主不参与；
//   - 节点命名 —— 宿主调 LLM（走 `ctx.llm`，与聊天同一条通路），结果按提问文本缓存，
//     再经本机的只读回环路由交给页面。
//
// 为什么命名放在宿主：这台机器的浏览器请求会走系统代理，而代理到不了模型端点；
// 宿主进程直连可用（与聊天一致），页面只访问 127.0.0.1，既绕开代理也没有 CORS 与密钥暴露。
//
// 路由（仅回环地址可访问）：
//   GET  /learnmap/llm.json  -> { enabled, provider, model }
//   POST /learnmap/labels    <- { items: [{ id, text, parent }] }
//                            -> { names: { [id]: name }, error?: string }
//
// 配置在用户自己的 profile 补丁层：
//   - id: learnmap
//     config:
//       provider: zai
//       model: glm-5.3-flash
//       apiKey: '...'     # 可选：ctx.llm 不可用时的直连兜底
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

const ROUTE_CONFIG = '/learnmap/llm.json'
const ROUTE_LABELS = '/learnmap/labels'
const DEFAULT_PROVIDER = 'zai'
const DEFAULT_MODEL = 'glm-5.3-flash'
const DEFAULT_BASE_URL = 'https://open.bigmodel.cn/api/paas/v4'
const BATCH = 8
const MAX_ITEMS = 40
const MAX_BODY = 64 * 1024
const CALL_TIMEOUT_MS = 25000
const CACHE_LIMIT = 500

const NAMING_SYSTEM = [
  '你在为一次学习会话生成「知识点目录」。',
  '给你若干条用户提问（q），请为每条生成一个中文知识点名称（name）。',
  '要求：',
  '1. 长度 6–18 个字，是一个完整、能独立看懂的名词短语，不要半截话，不要只有缩写。',
  '2. 英文专名/缩写保留原文，并用中文补齐语义，例如「EventLoop 事件循环」「TCP 三次握手」。',
  '3. 不要出现「请问」「解释」「介绍」「是什么」「为什么」这类提问语气，不要标点、不要引号、不要编号。',
  '4. 若 q 只是承接上文的半句（如「那微任务呢」），必须把 parent 的主题补进名字，形成「主题 + 侧重点」，例如「EventLoop 微任务」；但不要照抄 parent。',
  '5. 若 q 是宽泛的开场提问（如「开始讲讲 X」），用能概括该主题的完整名词，例如「X 整体结构与学习路径」。',
  '只输出 JSON 数组，形如 [{"i":0,"name":"..."}]，不要任何解释或代码块。'
].join('\n')

/** 稳定的短哈希（djb2），按提问文本缓存命名。 */
function hashText(text) {
  let hash = 5381
  const value = String(text || '')
  for (let i = 0; i < value.length; i++) hash = ((hash << 5) + hash + value.charCodeAt(i)) | 0
  return (hash >>> 0).toString(36)
}

function str(value, fallback) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback
}

/** 只接受本机回环地址。 */
function isLoopback(req) {
  const remote = req && req.socket && req.socket.remoteAddress
  return remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1'
}

/** 宽容解析模型回复：允许代码块包裹与前后废话，只取第一个 JSON 数组。 */
function parseNames(text) {
  const raw = String(text || '')
  const start = raw.indexOf('[')
  const end = raw.lastIndexOf(']')
  if (start < 0 || end <= start) return {}
  let list
  try {
    list = JSON.parse(raw.slice(start, end + 1))
  } catch (error) {
    return {}
  }
  const names = {}
  if (!Array.isArray(list)) return names
  for (const item of list) {
    if (!item || typeof item !== 'object') continue
    const index = Number(item.i)
    const name = String(item.name || '')
      .replace(/^[\s"'“”「」]+|[\s"'“”「」。，、；：]+$/g, '')
      .replace(/\s+/g, ' ')
      .trim()
    if (!Number.isFinite(index) || name.length < 1) continue
    // 超长只做安全截断（不加省略号，交给 CSS 省略，避免名字中间出现「…」）
    names[index] = name.length > 30 ? name.slice(0, 30) : name
  }
  return names
}

function chunk(list, size) {
  const out = []
  for (let index = 0; index < list.length; index += size) out.push(list.slice(index, index + size))
  return out
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const parts = []
    req.on('data', part => {
      size += part.length
      if (size > MAX_BODY) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      parts.push(part)
    })
    req.on('end', () => resolve(Buffer.concat(parts).toString('utf8')))
    req.on('error', reject)
  })
}

/** 磁盘缓存：跨重启复用命名结果，避免重复付费。 */
function createLabelCache(file) {
  let rows = {}
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    if (parsed && typeof parsed === 'object') rows = parsed
  } catch (error) {
    rows = {}
  }
  let timer = null
  const flush = () => {
    timer = null
    try {
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, JSON.stringify(rows))
    } catch (error) {
      // 写不进去不影响本次命名。
    }
  }
  return {
    get(key) {
      return Object.prototype.hasOwnProperty.call(rows, key) ? rows[key] : undefined
    },
    set(key, value) {
      rows[key] = value
      const keys = Object.keys(rows)
      if (keys.length > CACHE_LIMIT) {
        const kept = {}
        for (const old of keys.slice(keys.length - CACHE_LIMIT)) kept[old] = rows[old]
        rows = kept
      }
      if (timer === null) timer = setTimeout(flush, 800)
    }
  }
}

/** 一次模型调用：优先 `ctx.llm`（与聊天一条通路），失败再直连兜底。 */
async function callModel(ctx, options, batch) {
  const userPayload = JSON.stringify(
    batch.map((item, index) => ({
      i: index,
      q: String(item.text || '').slice(0, 400),
      parent: item.parent ? String(item.parent).slice(0, 120) : ''
    }))
  )
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), CALL_TIMEOUT_MS)
  try {
    const llm = typeof ctx.get === 'function' ? ctx.get('llm') : undefined
    if (llm && typeof llm.stream === 'function') {
      const stream = llm.stream({
        provider: options.provider,
        model: options.model,
        system: NAMING_SYSTEM,
        messages: [{ role: 'user', content: [{ type: 'text', text: userPayload }] }],
        temperature: 0.3,
        maxTokens: 900,
        signal: controller.signal
      })
      let text = ''
      for await (const chunkItem of stream) {
        if (!chunkItem || typeof chunkItem !== 'object') continue
        if (chunkItem.type === 'text-delta' && typeof chunkItem.text === 'string') text += chunkItem.text
        if (chunkItem.type === 'finish' && chunkItem.reason && chunkItem.reason.kind === 'error') {
          throw new Error((chunkItem.reason.failure && chunkItem.reason.failure.message) || 'model error')
        }
      }
      const names = parseNames(text)
      if (Object.keys(names).length > 0) return names
      throw new Error('empty completion')
    }
    throw new Error('llm service unavailable')
  } catch (error) {
    if (!options.apiKey) throw error
    // 直连兜底：宿主进程不走系统代理，通常可用。
    const res = await fetch(String(options.baseUrl).replace(/\/+$/, '') + '/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + options.apiKey },
      body: JSON.stringify({
        model: options.model,
        thinking: { type: 'disabled' },
        temperature: 0.3,
        max_tokens: 900,
        stream: false,
        messages: [
          { role: 'system', content: NAMING_SYSTEM },
          { role: 'user', content: userPayload }
        ]
      }),
      signal: controller.signal
    })
    if (!res.ok) throw new Error('HTTP ' + res.status)
    const json = await res.json()
    const message = json && json.choices && json.choices[0] && json.choices[0].message
    return parseNames(message ? message.content : '')
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 注册只读配置路由与命名路由。
 *
 * 注意：路由必须等 `webServer` 就绪再注册。冷启动时插件行往往**早于** web server 挂载，
 * 用 `ctx.get('webServer')` 只查一次会拿到 undefined 然后永远不再重试（表现就是页面显示
 * 「规则命名」、`/learnmap/*` 全部 404）。这里用 `ctx.inject` 等它出现，消失时自动重试。
 *
 * @param ctx - 宿主上下文。
 * @param config - 插件行 config（来自 profile 补丁层）。
 */
export function apply(ctx, config) {
  const raw = config && typeof config === 'object' ? config : {}
  const options = {
    provider: str(raw.provider, DEFAULT_PROVIDER),
    model: str(raw.model, DEFAULT_MODEL),
    baseUrl: str(raw.baseUrl, DEFAULT_BASE_URL),
    apiKey: str(raw.apiKey, ''),
    enabled: raw.enabled !== false
  }
  if (!ctx || typeof ctx.inject !== 'function') return

  const home = str(process.env.DSH_HOME, join(homedir(), '.dsh'))
  const cache = createLabelCache(join(home, 'storages', 'learnmap', 'labels.json'))
  let queue = Promise.resolve()

  const configPayload = JSON.stringify({ enabled: options.enabled, provider: options.provider, model: options.model })

  const respond = (res, status, payload) => {
    res.statusCode = status
    res.setHeader('content-type', 'application/json; charset=utf-8')
    res.setHeader('cache-control', 'no-store')
    res.end(JSON.stringify(payload))
  }

  ctx.inject(['webServer'], scope => {
    const web = scope.webServer
    if (!web || typeof web.register !== 'function') return

    ctx.effect(
      () =>
        web.register({
          kind: 'exact',
          path: ROUTE_CONFIG,
          handler(req, res) {
            if (!isLoopback(req)) {
              res.statusCode = 403
              res.end('forbidden')
              return
            }
            res.statusCode = 200
            res.setHeader('content-type', 'application/json; charset=utf-8')
            res.setHeader('cache-control', 'no-store')
            res.end(configPayload)
          }
        }),
      'learnmap: llm config route'
    )

    ctx.effect(
      () =>
        web.register({
          kind: 'exact',
          path: ROUTE_LABELS,
          async handler(req, res) {
            if (!isLoopback(req)) {
              res.statusCode = 403
              res.end('forbidden')
              return
            }
          if (options.enabled !== true) {
            respond(res, 200, { names: {}, error: 'disabled' })
            return
          }
          if (req.method !== 'POST') {
            respond(res, 405, { names: {}, error: 'POST required' })
            return
          }
          let items
          try {
            const body = JSON.parse(await readBody(req))
            items = body && Array.isArray(body.items) ? body.items : []
          } catch (error) {
            respond(res, 400, { names: {}, error: 'bad json' })
            return
          }
          const valid = items
            .filter(item => item && typeof item.id === 'string' && typeof item.text === 'string' && item.text.trim() !== '')
            .slice(0, MAX_ITEMS)
          if (valid.length === 0) {
            respond(res, 200, { names: {} })
            return
          }

          // 串行化：同一时刻只跑一次模型调用，避免重复付费与并发抖动。
          const run = async () => {
            const names = {}
            const missing = []
            for (const item of valid) {
              const cached = cache.get(hashText(item.text))
              if (cached !== undefined) names[item.id] = cached
              else missing.push(item)
            }
            let failure = null
            for (const batch of chunk(missing, BATCH)) {
              try {
                const got = await callModel(ctx, options, batch)
                for (const key of Object.keys(got)) {
                  const item = batch[Number(key)]
                  if (!item) continue
                  names[item.id] = got[key]
                  cache.set(hashText(item.text), got[key])
                }
              } catch (error) {
                failure = String((error && error.message) || error)
                break
              }
            }
            return { names, error: failure }
          }
          const pending = queue.then(run, run)
          queue = pending.then(
            () => undefined,
            () => undefined
          )
          try {
            const result = await pending
            respond(res, 200, result)
          } catch (error) {
            respond(res, 500, { names: {}, error: String((error && error.message) || error) })
          }
        }
      }),
      'learnmap: labels route'
    )
  })
}

export default { apply }
