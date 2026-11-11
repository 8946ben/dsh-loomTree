// 学习分支图 · Host 半区（0.2.x）。
//
// 分工：
//   - 父子关系 —— 浏览器半区先按规则建树，再由本插件请 LLM 复核明显错误；
//   - 节点命名 —— 宿主调 LLM（走 `ctx.llm`，与聊天同一条通路），结果按提问文本缓存，
//     再经本机的只读回环路由交给页面。
//
// 为什么模型调用放在宿主：这台机器的浏览器请求会走系统代理，而代理到不了模型端点；
// 宿主进程直连可用（与聊天一致），页面只访问 127.0.0.1，既绕开代理也没有 CORS 与密钥暴露。
//
// 路由（仅回环地址可访问）：
//   GET  /learnmap/llm.json   -> { enabled, provider, model, relate }
//   POST /learnmap/labels     <- { items: [{ id, text, parent }] }
//                             -> { names: { [id]: name }, error?: string }
//   POST /learnmap/relations  <- { items: [{ id, seq, text, parent }] }
//                             -> { parents: { [id]: parentId | 'root' }, error?: string }
//
// 配置在用户自己的 profile 补丁层：
//   - id: learnmap
//     config:
//       provider: zai
//       model: glm-5.3-flash
//       relate: true       # false = 不做 LLM 关系复核（仍用规则关系）
//       apiKey: '...'      # 可选：ctx.llm 不可用时的直连兜底
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

const ROUTE_CONFIG = '/learnmap/llm.json'
const ROUTE_LABELS = '/learnmap/labels'
const ROUTE_RELATIONS = '/learnmap/relations'
const DEFAULT_PROVIDER = 'zai'
const DEFAULT_MODEL = 'glm-5.3-flash'
const DEFAULT_BASE_URL = 'https://open.bigmodel.cn/api/paas/v4'
const BATCH = 8
const MAX_ITEMS = 40
const MAX_RELATION_ITEMS = 80
const MAX_BODY = 128 * 1024
const CALL_TIMEOUT_MS = 25000
const CACHE_LIMIT = 500

const NAMING_SYSTEM = [
  '你在为一次学习会话生成「知识点目录」。',
  '给你若干条用户提问（q），请为每条生成一个中文知识点名称（name）。',
  '要求：',
  '1. 长度 6–18 个字，是一个完整、能独立看懂的名词短语，不要半截话，不要只有缩写。',
  '2. 英文专名/缩写保留原文，并用中文补齐语义，例如「EventLoop 事件循环」「TCP 三次握手」。',
  '3. 不要出现「请问」「解释」「介绍」「是什么」「为什么」这类提问语气，不要标点、不要引号、不要编号。',
  '4. 只有 q 省略了主语（如「那微任务呢」「它呢」「继续」）才补 parent 的主题；q 本身已经点明主题时，禁止添加 parent 或上下文里的技术名词。名字必须只从 q 本身就能推出来。',
  '5. 不得引入 q 中没有的技术限定词。例如 q 是「特征级自回归草稿都有哪些」，不要因为 parent 是「扩散草稿」就写成「扩散模型特征级自回归草稿…」。',
  '6. 若 q 是宽泛的开场提问（如「开始讲讲 X」），用能概括该主题的完整名词，例如「X 整体结构与学习路径」。',
  '只输出 JSON 数组，形如 [{"i":0,"name":"..."}]，不要任何解释或代码块。'
].join('\n')

const RELATION_SYSTEM = [
  '你在整理一段技术问答会话的知识树。',
  '输入是 nodes（按时间排序，每个节点有 id、seq、q、a、parent）以及 fresh（本次新增节点的 id 数组，可能为空）。',
  '任务：检查节点的直接父节点在主题从属关系上是否合理，并修正明显错误。',
  '规则：',
  '1. 父节点可以是 nodes 里任意一个节点（不必更早），也可以写 "root"；不能指向自己、不能形成环。',
  '2. fresh 非空时，只调整并只输出 fresh 中的节点，其他节点的 parent 保持原样；fresh 为空时才检查全部节点。',
  '3. 优先挂到已有的总览/分类节点下。只有确实没有共同主题节点时，才写 "root" 建立一个顶层主题；不要把能以总览节点为父的节点提成 root。',
  '4. 具体方法 / 模型 / 论文应挂到它所属的分类下：EAGLE-1 是「特征级自回归草稿」的具体方法 → 挂在它下面，不要提为 root。',
  '5. 相近但不相同的类别不要硬挂：父节点是「特征级自回归草稿」，子节点是「半自回归特征级草稿」时，不能挂在它下面；应上移到共同祖先（如「投机解码方法概览」），与近似分类并列。',
  '6. 结合 a：如果 a 明确说「不是 X」「介于 X 与 Y 之间」「半自回归」等，而父节点是 X 的分类，就不能挂在 X 下，应上移到共同祖先。',
  '7. 并列、交叉、只共享关键词都不算父子，应挂到共同祖先（扩散草稿与特征级自回归草稿是并列的两类，都挂在「投机解码」下）。',
  '8. 相邻序号不代表从属关系，不要串成一条链；「它」「这个」「那……呢」这类承接上文的追问，挂到上文对应的具体节点。',
  '9. 对每个需要判断的节点都给出判断（即使保持原样也写一遍）；fresh 非空时只写 fresh 中的节点，fresh 为空时写所有 parent 不为 root 的节点；没把握就写原 parent，不要省略。',
  '10. 示例：',
  '   - EAGLE-1「工作原理」→ 父节点「特征级自回归草稿」（它在该分类的回答里被列为具体方法）。',
  '   - DSpark 是「半自回归特征级草稿」，现有分类只有「特征级自回归草稿」→ 父节点「投机解码方法概览」，与「特征级自回归草稿」并列；不要挂到「特征级自回归草稿」下。',
  '   - 「扩散草稿」与「特征级自回归草稿」是并列分类，父节点都为「投机解码方法概览」，不要互相挂。',
  '只输出 JSON 对象：{"parents":{"<节点 id>":"<父节点 id 或 root>"}}，覆盖 fresh 指定的节点（fresh 为空时覆盖所有 parent 不为 root 的节点）；不要解释、不要代码块。'
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

/** 宽容解析关系回复：只取第一个 JSON 对象里的 parents 表。 */
function parseRelations(text) {
  const raw = String(text || '')
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start < 0 || end <= start) return {}
  let parsed
  try {
    parsed = JSON.parse(raw.slice(start, end + 1))
  } catch (error) {
    return {}
  }
  const table = parsed && parsed.parents && typeof parsed.parents === 'object' ? parsed.parents : {}
  const pairs = Array.isArray(table) ? table : Object.keys(table).map(id => ({ id, parent: table[id] }))
  const parents = {}
  for (const item of pairs) {
    if (!item || typeof item !== 'object') continue
    const id = item.id
    const parent = item.parent
    if (typeof id !== 'string' || typeof parent !== 'string') continue
    const value = parent.trim()
    if (value === '') continue
    parents[id] = value
  }
  return parents
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

/**
 * 一次模型调用：优先 `ctx.llm`（与聊天一条通路），失败再直连兜底。
 * @param ctx - 宿主上下文。
 * @param options - `{ provider, model, baseUrl, apiKey }`。
 * @param request - `{ system, payload, temperature, maxTokens, parse }`；parse 返回非空对象才算成功。
 * @returns parser 的结果。
 */
async function callChat(ctx, options, request) {
  const { system, payload, temperature, maxTokens, parse, allowEmpty } = request
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), CALL_TIMEOUT_MS)
  try {
    const llm = typeof ctx.get === 'function' ? ctx.get('llm') : undefined
    if (llm && typeof llm.stream === 'function') {
      const stream = llm.stream({
        provider: options.provider,
        model: options.model,
        system,
        messages: [{ role: 'user', content: [{ type: 'text', text: payload }] }],
        temperature,
        maxTokens,
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
      const parsed = parse(text)
      // 关系复核允许「模型认为不用改」的空结果；命名则必须至少拿到一个名字。
      if (allowEmpty === true || Object.keys(parsed).length > 0) return parsed
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
        temperature,
        max_tokens: maxTokens,
        stream: false,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: payload }
        ]
      }),
      signal: controller.signal
    })
    if (!res.ok) throw new Error('HTTP ' + res.status)
    const json = await res.json()
    const message = json && json.choices && json.choices[0] && json.choices[0].message
    return parse(message ? message.content : '')
  } finally {
    clearTimeout(timer)
  }
}

/** 为一批提问起名（返回 `{ 索引: 名字 }`）。 */
function callModel(ctx, options, batch) {
  const payload = JSON.stringify(
    batch.map((item, index) => ({
      i: index,
      q: String(item.text || '').slice(0, 400),
      parent: item.parent ? String(item.parent).slice(0, 120) : ''
    }))
  )
  return callChat(ctx, options, {
    system: NAMING_SYSTEM,
    payload,
    temperature: 0.3,
    maxTokens: 900,
    parse: parseNames
  })
}

/** 复核整棵树的父子关系（返回 `{ [节点 id]: 父节点 id | 'root' }`，只含要改的）。 */
function callRelations(ctx, options, items) {
  const payload = JSON.stringify({
    nodes: items.map(item => ({
      id: item.id,
      seq: item.seq,
      q: String(item.text || '').slice(0, 300),
      a: String(item.answer || '').slice(0, 4000),
      parent: item.parent || 'root'
    })),
    fresh: Array.isArray(options.fresh) ? options.fresh : []
  })
  return callChat(ctx, options, {
    system: RELATION_SYSTEM,
    payload,
    temperature: 0.2,
    maxTokens: 2000,
    parse: parseRelations,
    allowEmpty: true
  })
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
    enabled: raw.enabled !== false,
    relate: raw.relate !== false
  }
  if (!ctx || typeof ctx.inject !== 'function') return

  const home = str(process.env.DSH_HOME, join(homedir(), '.dsh'))
  const cache = createLabelCache(join(home, 'storages', 'learnmap', 'labels-v2.json'))
  let queue = Promise.resolve()

  const configPayload = JSON.stringify({
    enabled: options.enabled,
    provider: options.provider,
    model: options.model,
    relate: options.relate
  })

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

    // LLM 复核父子关系：只回环、只 POST。父节点必须更早这条约束由页面二次校验。
    ctx.effect(
      () =>
        web.register({
          kind: 'exact',
          path: ROUTE_RELATIONS,
          async handler(req, res) {
            if (!isLoopback(req)) {
              res.statusCode = 403
              res.end('forbidden')
              return
            }
            if (options.enabled !== true || options.relate !== true) {
              respond(res, 200, { parents: {}, error: 'disabled' })
              return
            }
            if (req.method !== 'POST') {
              respond(res, 405, { parents: {}, error: 'POST required' })
              return
            }
            let items
            let fresh = []
            try {
              const body = JSON.parse(await readBody(req))
              items = body && Array.isArray(body.items) ? body.items : []
              fresh = body && Array.isArray(body.fresh) ? body.fresh.filter(id => typeof id === 'string').slice(0, MAX_RELATION_ITEMS) : []
            } catch (error) {
              respond(res, 400, { parents: {}, error: 'bad json' })
              return
            }
            const valid = items
              .filter(item => item && typeof item.id === 'string' && typeof item.text === 'string' && item.text.trim() !== '')
              .map(item => ({
                id: item.id,
                seq: Number.isFinite(item.seq) ? item.seq : 0,
                text: item.text,
                answer: typeof item.answer === 'string' ? item.answer.slice(0, 4000) : '',
                parent: typeof item.parent === 'string' && item.parent !== '' ? item.parent : 'root'
              }))
              .slice(0, MAX_RELATION_ITEMS)
            if (valid.length < 2) {
              respond(res, 200, { parents: {} })
              return
            }

            const run = async () => {
              try {
                const got = await callRelations(ctx, { ...options, fresh }, valid)
                const ids = new Set(valid.map(item => item.id))
                const parents = {}
                for (const id of Object.keys(got)) {
                  if (!ids.has(id)) continue
                  const parent = got[id]
                  if (parent !== 'root' && !ids.has(parent)) continue
                  if (parent === id) continue
                  parents[id] = parent
                }
                return { parents }
              } catch (error) {
                return { parents: {}, error: String((error && error.message) || error) }
              }
            }
            const pending = queue.then(run, run)
            queue = pending.then(
              () => undefined,
              () => undefined
            )
            respond(res, 200, await pending)
          }
        }),
      'learnmap: relations route'
    )
  })
}

export default { apply }
