// 学习分支图 · 浏览器半区（DeepSeek Harness 0.2.x 契约）
//
// 挂载点：`conversation.input.dock` —— 输入框上方的会话级列表槽（list / session
// scope，replaceRisk none）。它自带标准 props `sessionId` / `useSession` /
// `useChat` 与 ownerProps `InputZone { session, input }`，正好满足「不遮挡对话、
// 常驻在输入区上方、跟随当前会话」的要求。
//
// 数据来源：`ctx.get('sessions').binding(sessionId).eventSource` 的会话事件窗口
// （0.2.x 的真实账本）。插件只读，不写事件；窗口随会话滚动，因此树上永远只有
// 已经加载、可以跳过去的那部分问答。
//
// 模块契约：静态 client bundle 只注册工厂；`id` 必须是包名；工厂的导出
// （`apply` + `inject`）就是 cordis 插件本身。
window.__ModuleLoader__.load({
	id: '@learnmap/web-plugin',
	factory: require => {
		const React = require('react')
		const h = React.createElement
		const { useState, useEffect, useMemo, useCallback } = React

		const STYLE_ID = 'learnmap-style'
		/** 面板展开状态存在 localStorage，刷新与切换会话都不丢。 */
		const OPEN_KEY = 'learnmap.open'

		// apply() 里的 ctx 供组件渲染期借用（只读服务借用，不持有资源）。
		let pluginCtx = null

		// ==============================================================
		// 1. 文本与术语
		// ==============================================================

		const STOPWORDS = new Set(
			(
				'the a an is are was were be been being what how why who when where which explain tell about with for of ' +
				'and or in on at to from please me my this that these those it its more again continue continuing going ' +
				'back return into detail deep deeper know want like can could would should does do did not no yes ok okay ' +
				'let us have has had get got make made see look read write help need try using use used first then now ' +
				'also just really actually understand understood mean means meaning say said talk speak chat agent answer ' +
				'question introduce introduction learn learning study studying content contents main summary summarize ' +
				'example examples note notes part parts section sections list step steps etc vs ' +
				'继续 继续讲 讲一下 说一下 展开 详细 具体 一下 这个 那个 我们 你们 什么 为什么 怎么 如何 可以 能否 帮我 请问 解释 介绍'
			).split(/\s+/)
		)

		/** 内容块数组里的纯文本（text / reasoning），忽略工具与图片噪声。 */
		function textOf(blocks) {
			if (typeof blocks === 'string') return blocks
			if (!Array.isArray(blocks)) return ''
			const out = []
			for (const block of blocks) {
				if (!block || typeof block !== 'object') continue
				if ((block.type === 'text' || block.kind === 'text') && typeof block.text === 'string' && block.text) out.push(block.text)
			}
			return out.join('\n')
		}

		/** 提取提问中的「术语」：引号短语、全大写缩写、首字母大写词、含数字词。 */
		function extractTerms(question) {
			const terms = []
			const seen = new Set()
			const push = raw => {
				const t = typeof raw === 'string' ? raw.trim() : ''
				if (t.length < 2 || t.length > 40) return
				const key = t.toLowerCase()
				if (seen.has(key) || STOPWORDS.has(key)) return
				seen.add(key)
				terms.push(t)
			}
			const quoteRe = /「([^」]+)」|『([^』]+)』|“([^”]+)”|‘([^’]+)’|"([^"]+)"|《([^》]+)》|【([^】]+)】/g
			let m
			while ((m = quoteRe.exec(question)) !== null) {
				for (let i = 1; i <= 7; i++) if (m[i] !== undefined) push(m[i])
			}
			const latinRe = /[A-Za-z][A-Za-z0-9_.\-]{1,}/g
			while ((m = latinRe.exec(question)) !== null) {
				const tok = m[0]
				if (/^[A-Z]{2,}$/.test(tok) || /^[A-Z]/.test(tok) || /\d/.test(tok)) push(tok)
			}
			return terms
		}

		/** 节点标题：优先第一个术语，否则去掉客套话后的前 22 字。 */
		function deriveLabel(question, terms) {
			if (terms.length > 0) return terms[0].length > 30 ? terms[0].slice(0, 30) + '…' : terms[0]
			const cleaned = question.replace(/^(请|麻烦|帮我|你|请问|可以|能不能|能否|我想|我希望|我们)[，,、\s]*/, '').trim()
			const base = cleaned || question
			return base.length > 22 ? base.slice(0, 22) + '…' : base
		}

		/**
		 * 选择父节点：命中术语的最近段落 → 否则线性挂到上一段；
		 * 「回到最初」这类提问挂到第一个节点。
		 */
		function findParent(segments, question, selfId) {
			const others = segments.filter(seg => seg.id !== selfId)
			if (others.length === 0) return null
			if (
				others.length > 1 &&
				/回到|回去|返回|重新|再看/.test(question) &&
				/最初|开头|最开始|开始|第一|首次|根本|原点/.test(question)
			) {
				return others[0].id
			}
			const terms = extractTerms(question)
			if (terms.length === 0) return others[others.length - 1].id
			let best = null
			let bestScore = 0
			for (const seg of others) {
				const corpus = (seg.text + '\n' + seg.assistantText).toLowerCase()
				let score = 0
				for (const term of terms) if (corpus.includes(term.toLowerCase())) score++
				if (score > bestScore) {
					bestScore = score
					best = seg
				}
			}
			return best !== null ? best.id : others[others.length - 1].id
		}

		// ==============================================================
		// 2. 会话事件窗口 -> 知识点树
		// ==============================================================

		/**
		 * 把一窗会话事件折成知识点树。
		 * 只认 `user/message`（source.kind === 'user'，即真人提问）作为节点；
		 * 后续 `assistant/message` 的正文累积到最近节点，供术语关联打分。
		 * @param entries - SessionEventWindow.entries（event / transient 两类条目）。
		 * @returns `{ roots, count, latestId }`，roots 里每个节点带 children。
		 */
		function buildTree(entries) {
			const segments = []
			const list = Array.isArray(entries) ? entries : []
			for (let i = 0; i < list.length; i++) {
				const entry = list[i]
				if (!entry || entry.type !== 'event') continue
				const event = entry.event
				if (!event || typeof event !== 'object') continue

				if (event.type === 'user/message') {
					const data = event.data
					if (!data || typeof data !== 'object') continue
					// 只收真人提问：工具/系统构造的 user 消息不算知识点。
					if (data.source && typeof data.source === 'object' && data.source.kind !== 'user') continue
					// 改写（replace）是编辑旧消息，由它自己的 append 事件负责。
					if (event.surfaceOp !== undefined && event.surfaceOp !== 'append') continue
					const text = textOf(data.content)
					if (!text) continue
					const id = String(data.id)
					if (segments.some(seg => seg.id === id)) continue
					const terms = extractTerms(text)
					const segment = {
						id,
						seq: typeof event.seq === 'number' ? event.seq : 0,
						time: typeof event.time === 'number' ? event.time : 0,
						text,
						label: deriveLabel(text, terms),
						parentId: null,
						assistantText: ''
					}
					segment.parentId = findParent(segments, text, id)
					segments.push(segment)
					continue
				}

				if (event.type === 'assistant/message') {
					const message = event.data && event.data.message
					if (!message) continue
					const text = textOf(message.content)
					if (!text) continue
					const last = segments[segments.length - 1]
					if (!last) continue
					last.assistantText = last.assistantText ? last.assistantText + '\n' + text : text
					if (last.assistantText.length > 20000) last.assistantText = last.assistantText.slice(0, 20000)
				}
			}

			const byId = new Map()
			for (const seg of segments) byId.set(seg.id, Object.assign({}, seg, { children: [] }))
			const roots = []
			for (const seg of segments) {
				const node = byId.get(seg.id)
				const parent = seg.parentId === null ? undefined : byId.get(seg.parentId)
				if (parent) parent.children.push(node)
				else roots.push(node)
			}
			return {
				roots,
				count: segments.length,
				latestId: segments.length > 0 ? segments[segments.length - 1].id : null
			}
		}

		// ==============================================================
		// 3. 跳转回对应提问
		// ==============================================================

		const cssEscape = value => String(value).replace(/["\\]/g, '\\$&')
		const norm = value => String(value || '').replace(/\s+/g, ' ').trim().toLowerCase()
		const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

		/** 在对话流里找一条消息行：先按键精确/后缀匹配，再按提问文本兜底。 */
		function findMessageRow(messageId, question) {
			if (typeof document === 'undefined') return null
			const key = cssEscape(messageId)
			const direct =
				document.querySelector('[data-chat-flow-key="' + key + '"]') ||
				document.querySelector('[data-chat-node-key="' + key + '"]') ||
				document.querySelector('[data-chat-flow-key$="' + key + '"]') ||
				document.querySelector('[data-chat-node-key$="' + key + '"]')
			if (direct !== null) return direct

			const q = norm(question)
			if (q.length < 2) return null
			const rows = Array.from(document.querySelectorAll('[data-chat-flow-kind="user"], [data-chat-flow-kind="steering"]'))
			let best = null
			let bestScore = -1
			for (let i = 0; i < rows.length; i++) {
				const text = norm(rows[i].textContent)
				if (!text.includes(q)) continue
				let score = text.startsWith(q) ? 1000 : 0
				score += Math.max(0, 300 - text.length) + i / 1000
				if (score > bestScore) {
					bestScore = score
					best = rows[i]
				}
			}
			return best
		}

		function flashRow(element) {
			try {
				element.scrollIntoView({ behavior: 'smooth', block: 'center' })
			} catch (error) {
				element.scrollIntoView()
			}
			element.classList.remove('lm-flash')
			// 强制重排，让动画可以重放。
			void element.offsetWidth
			element.classList.add('lm-flash')
			setTimeout(() => element.classList.remove('lm-flash'), 1900)
		}

		/**
		 * 跳到某条提问。行不在 DOM 里时，先用会话面 `loadThrough(seq)` 把历史加载到
		 * 该序号，再重试（窗口没有覆盖到的旧消息因此也能跳）。
		 * @returns true 表示已经滚动到目标行。
		 */
		async function jumpTo(segment, binding) {
			let row = findMessageRow(segment.id, segment.text)
			if (row !== null) {
				flashRow(row)
				return true
			}
			const face = binding && binding.session
			if (face && typeof face.loadThrough === 'function' && segment.seq > 0) {
				try {
					await face.loadThrough(segment.seq)
				} catch (error) {
					// 加载失败就让下面的重试给出「找不到」结论。
				}
				for (let i = 0; i < 20; i++) {
					await sleep(120)
					row = findMessageRow(segment.id, segment.text)
					if (row !== null) {
						flashRow(row)
						return true
					}
				}
			}
			return false
		}

		// ==============================================================
		// 3.5 LLM 命名（只接管「名字」，不接管「关系」）
		// ==============================================================
		//
		// 父子关系仍由 buildTree 的规则决定；这里只把「提问 → 简短知识点名」这一步
		// 交给模型，结果按提问文本缓存，命中缓存就不再请求。任何一步失败都静默退回
		// 规则标题，绝不阻塞或破坏这棵树。

		const CFG_ROUTE = '/learnmap/llm.json'
		const LABELS_ROUTE = '/learnmap/labels'
		const LABEL_CACHE = 'learnmap.llm.labels.v2'
		const LABEL_CACHE_MAX = 600
		const MAX_REQUEST = 40
		/** 正在请求中的提问哈希：避免快速追问时对同一批问题重复付费。 */
		const namingInFlight = new Set()
		/** 稳定的短哈希（djb2），用于按提问文本缓存命名。 */
		function hashText(text) {
			let hash = 5381
			const value = String(text || '')
			for (let i = 0; i < value.length; i++) hash = ((hash << 5) + hash + value.charCodeAt(i)) | 0
			return (hash >>> 0).toString(36)
		}

		function readStore(key) {
			try {
				return localStorage.getItem(key)
			} catch (error) {
				return null
			}
		}

		function writeStore(key, value) {
			try {
				localStorage.setItem(key, value)
			} catch (error) {
				// 隐私模式等场景下忽略持久化失败。
			}
		}

		/** 命名缓存：提问文本哈希 -> 名称。 */
		function readLabelCache() {
			try {
				const parsed = JSON.parse(readStore(LABEL_CACHE) || '{}')
				return parsed && typeof parsed === 'object' ? parsed : {}
			} catch (error) {
				return {}
			}
		}

		function writeLabelCache(hash, name) {
			try {
				const cache = readLabelCache()
				cache[hash] = name
				const keys = Object.keys(cache)
				if (keys.length > LABEL_CACHE_MAX) {
					const kept = {}
					for (const key of keys.slice(keys.length - LABEL_CACHE_MAX)) kept[key] = cache[key]
					writeStore(LABEL_CACHE, JSON.stringify(kept))
					return
				}
				writeStore(LABEL_CACHE, JSON.stringify(cache))
			} catch (error) {
				// 缓存失败不影响本次显示。
			}
		}

		/**
		 * 读取命名能力状态（宿主路由）。密钥与模型调用都在宿主，页面只拿开关与模型名。
		 * @returns `null` 表示宿主没有提供命名能力（退化为纯规则命名）。
		 */
		async function loadLlmConfig() {
			try {
				const res = await fetch(CFG_ROUTE, { credentials: 'same-origin', cache: 'no-store' })
				if (!res.ok) return null
				const info = await res.json()
				if (!info || info.enabled !== true) return null
				return {
					enabled: true,
					provider: typeof info.provider === 'string' ? info.provider : '',
					model: typeof info.model === 'string' ? info.model : '',
					relate: info.relate !== false
				}
			} catch (error) {
				return null
			}
		}

		/**
		 * 请求宿主为一组提问命名（宿主内部再分批调模型）。
		 * @param items - `[{ id, text, parent }]`。
		 * @param signal - 可选的取消信号。
		 * @returns `{ names: { [id]: name }, error?: string }`。
		 */
		async function requestNames(items, signal) {
			const res = await fetch(LABELS_ROUTE, {
				method: 'POST',
				credentials: 'same-origin',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					items: items.slice(0, MAX_REQUEST).map(item => ({
						id: item.id,
						text: item.text,
						parent: item.parent || ''
					}))
				}),
				signal
			})
			if (!res.ok) throw new Error('HTTP ' + res.status)
			const json = await res.json()
			return {
				names: json && json.names && typeof json.names === 'object' ? json.names : {},
				error: json && typeof json.error === 'string' ? json.error : null
			}
		}

		// ---- 命名状态放在模块级：>1 个面板（输入框上方 + 右侧栏图）共享同一份结果 ----

		const namingStore = {
			labels: {},
			status: 'idle', // idle | busy | failed
			error: null,
			version: 0,
			listeners: new Set(),
			subscribe(listener) {
				this.listeners.add(listener)
				return () => {
					this.listeners.delete(listener)
				}
			},
			emit() {
				this.version += 1
				for (const listener of Array.from(this.listeners)) {
					try {
						listener()
					} catch (error) {
						console.error('[learnmap] naming listener:', error)
					}
				}
			},
			/** 局部更新并广播。 */
			patch(next) {
				if (next.labels) this.labels = Object.assign({}, this.labels, next.labels)
				if (next.status !== undefined) this.status = next.status
				if (next.error !== undefined) this.error = next.error
				this.emit()
			}
		}

		/** 订阅命名状态（用版本号触发重渲染，避免把整个 store 塞进 React 状态）。 */
		function useNaming() {
			const [version, setVersion] = useState(namingStore.version)
			useEffect(() => namingStore.subscribe(() => setVersion(namingStore.version)), [])
			return { version, labels: namingStore.labels, status: namingStore.status, error: namingStore.error }
		}

		/**
		 * 驱动一次命名：只处理「还没名字、也没在飞」的节点。
		 * 模块级去重，所以输入框面板与侧栏图同时挂载也不会重复付费。
		 * @param tree - buildTree 的结果。
		 * @param config - loadLlmConfig() 的结果；为 null 时直接返回。
		 */
		async function driveNaming(tree, config) {
			if (!config) return
			const cache = readLabelCache()
			const pending = []
			const walk = (nodes, parentText) => {
				for (const node of nodes) {
					const key = hashText(node.text)
					if (namingStore.labels[node.id] === undefined && cache[key] === undefined && !namingInFlight.has(key)) {
						namingInFlight.add(key)
						pending.push({ id: node.id, text: node.text, parent: parentText })
					}
					walk(node.children, node.text)
				}
			}
			walk(tree.roots, '')
			if (pending.length === 0) return

			const batch = pending.slice(0, MAX_REQUEST)
			for (const item of pending.slice(MAX_REQUEST)) namingInFlight.delete(hashText(item.text))
			namingStore.patch({ status: 'busy', error: null })
			try {
				const result = await requestNames(batch)
				const found = {}
				for (const id of Object.keys(result.names)) {
					const name = result.names[id]
					if (typeof name !== 'string' || name === '') continue
					found[id] = name
					const item = batch.find(entry => entry.id === id)
					if (item) writeLabelCache(hashText(item.text), name)
				}
				const named = Object.keys(found).length
				namingStore.patch({
					labels: found,
					status: result.error !== null && named === 0 ? 'failed' : 'idle',
					error: result.error
				})
			} catch (error) {
				namingStore.patch({ status: 'failed', error: String((error && error.message) || error) })
			} finally {
				for (const item of batch) namingInFlight.delete(hashText(item.text))
			}
		}

		/**
		 * 会话侧的统一读取：事件窗口 → 树 → 命名。两个面板共用。
		 * @param sessionId - 当前会话。
		 * @returns 树、窗口、binding、显示名解析与跳转动作。
		 */
		function useLearnmapSession(sessionId) {
			const binding = useBinding(sessionId)
			const windowState = useEventWindow(binding)
			const baseTree = useMemo(() => buildTree(windowState.entries), [windowState])
			const edits = useEdits()
			const relations = useRelations()
			// 切换会话时丢掉上一个会话的修正结果，避免徽标和旧映射串台（节点 id 全局唯一，不会误挂）。
			useEffect(() => {
				if (!sessionId) return
				if (relationsStore.sessionId === sessionId) return
				relationsStore.patch({ sessionId, parents: {}, signature: null, status: 'idle', error: null })
			}, [sessionId])
			// 顺序很重要：规则树 → LLM 关系修正 → 手动编辑（人工改关系永远最后生效）。
			const llmTree = useMemo(() => applyLlmParents(baseTree, relations.parents), [baseTree, relations.parents])
			const tree = useMemo(() => applyEdits(llmTree, editStore), [llmTree, edits.version])
			const naming = useNaming()
			const [llmConfig, setLlmConfig] = useState(undefined)

			useEffect(() => {
				let alive = true
				loadLlmConfig()
					.then(config => {
						if (alive) setLlmConfig(config)
					})
					.catch(() => {
						if (alive) setLlmConfig(null)
					})
				return () => {
					alive = false
				}
			}, [])

			// 树变化 → 防抖后补名字；已发出的请求不中断（模块级去重防止重复付费）。
			useEffect(() => {
				if (!llmConfig) return undefined
				const timer = setTimeout(() => {
					driveNaming(tree, llmConfig)
				}, 700)
				return () => clearTimeout(timer)
			}, [tree, llmConfig])

			// 规则树变化 → 防抖后请模型复核关系；节点集合不变时 driveRelations 内部直接跳过。
			// 一旦用户手动改过关系，就完全让位给人工布局（清掉之前的 LLM 修正，避免两套关系打架）。
			useEffect(() => {
				if (!llmConfig || llmConfig.relate === false) return undefined
				if (Object.keys(editStore.parents).length > 0) {
					if (Object.keys(relationsStore.parents).length > 0) relationsStore.patch({ parents: {}, signature: null, status: 'idle', error: null })
					return undefined
				}
				const timer = setTimeout(() => {
					driveRelations(baseTree, llmConfig)
				}, 900)
				return () => clearTimeout(timer)
			}, [baseTree, llmConfig, edits.version])

			/** 手动触发一次复核：清掉签名/缓存绕过，用于「复核」和「重试」按钮。 */
			const recheckRelations = useCallback(() => {
				if (!llmConfig || llmConfig.relate === false) return
				if (!baseTree || baseTree.count < 2) return
				relationsStore.patch({ parents: {}, signature: null, status: 'busy', error: null })
				return driveRelations(baseTree, llmConfig, { force: true })
			}, [baseTree, llmConfig])

			const displayNames = useMemo(() => {
				const cache = readLabelCache()
				const map = new Map()
				const walk = nodes => {
					for (const node of nodes) {
						map.set(node.id, node.custom || naming.labels[node.id] || cache[hashText(node.text)] || node.label)
						walk(node.children)
					}
				}
				walk(tree.roots)
				return map
			}, [tree, naming.version])

			const [busy, setBusy] = useState(false)
			const [note, setNote] = useState(null)
			const onJump = useCallback(
				segment => {
					setBusy(true)
					setNote(null)
					jumpTo(segment, binding)
						.then(found => {
							setBusy(false)
							if (!found) setNote('没有在对话里找到这条提问（可能已被压缩或尚未加载）。')
						})
						.catch(error => {
							setBusy(false)
							setNote('跳转失败：' + String((error && error.message) || error))
						})
				},
				[binding]
			)

			return {
				binding,
				windowState,
				tree,
				llmConfig,
				naming,
				relations: relations.parents,
				relationStatus: relations.status,
				relationChecked: relations.signature !== null,
				relationError: relations.error,
				recheckRelations,
				editVersion: edits.version,
				displayName: node => displayNames.get(node.id) || node.label,
				busy,
				note,
				onJump
			}
		}

		// ==============================================================
		// 4. 读取会话事件窗口
		// ==============================================================

		const EMPTY_WINDOW = Object.freeze({ entries: [], hasMore: false, revision: -1 })

		/** 借用（不持有）当前会话的 binding；会话未 retain 时为 undefined。 */
		function lookupBinding(sessionId) {
			const ctx = pluginCtx
			if (!ctx || typeof ctx.get !== 'function' || !sessionId) return undefined
			const sessions = ctx.get('sessions')
			if (!sessions || typeof sessions.binding !== 'function') return undefined
			try {
				return sessions.binding(sessionId)
			} catch (error) {
				return undefined
			}
		}

		function readWindow(binding) {
			const source = binding && binding.eventSource
			if (!source || typeof source.getSnapshot !== 'function') return EMPTY_WINDOW
			try {
				return source.getSnapshot() || EMPTY_WINDOW
			} catch (error) {
				return EMPTY_WINDOW
			}
		}

		/** 订阅当前会话的事件窗口；窗口是不可变快照，内容不变时 React 自然跳过。 */
		function useEventWindow(binding) {
			const [windowState, setWindowState] = useState(() => readWindow(binding))
			useEffect(() => {
				const source = binding && binding.eventSource
				if (!source || typeof source.subscribe !== 'function') {
					setWindowState(readWindow(binding))
					return undefined
				}
				const push = () => setWindowState(readWindow(binding))
				push()
				return source.subscribe(push)
			}, [binding])
			return windowState
		}

		/**
		 * 会话 binding 是渲染期借用：首次渲染时 shell 可能还没 retain 完，
		 * 这里做有限次重探（首帧后 ~6 秒内），拿到就停。
		 */
		function useBinding(sessionId) {
			const [probe, setProbe] = useState(0)
			const binding = useMemo(() => lookupBinding(sessionId), [sessionId, probe])
			useEffect(() => {
				if (binding !== undefined || probe > 20) return undefined
				const timer = setTimeout(() => setProbe(value => value + 1), 300)
				return () => clearTimeout(timer)
			}, [binding, probe])
			return binding
		}

		// ==============================================================
		// 5. 组件
		// ==============================================================

		function readOpen() {
			try {
				return localStorage.getItem(OPEN_KEY) === '1'
			} catch (error) {
				return false
			}
		}

		function writeOpen(open) {
			try {
				localStorage.setItem(OPEN_KEY, open ? '1' : '0')
			} catch (error) {
				// 隐私模式等场景下忽略持久化失败。
			}
		}

		/** 标准 props 缺失时给出可读的降级提示，而不是让整个槽位崩掉。 */
		// ---- 细条上的图标（纯 SVG，跟文字按钮的视觉重量对齐）----
		/** 「在右侧栏打开」：一个面板 + 斜向箭头。 */
		function iconOpenPanel() {
			return h(
				'svg',
				{ className: 'lm-ico', viewBox: '0 0 16 16', width: 14, height: 14, 'aria-hidden': true },
				h('path', { d: 'M6.5 3.5H3.5v9h9v-3' }),
				h('path', { d: 'M9.5 3.5h3v3' }),
				h('path', { d: 'M12.5 3.5 8 8' })
			)
		}

		/** 「全部展开 / 全部收起」：两层折角，方向由 down/up 决定。 */
		function iconChevrons(direction) {
			const first = direction === 'up' ? 'M4.5 6.5 8 3 11.5 6.5' : 'M4.5 5.5 8 9 11.5 5.5'
			const second = direction === 'up' ? 'M4.5 11.5 8 8 11.5 11.5' : 'M4.5 9.5 8 13 11.5 9.5'
			return h(
				'svg',
				{ className: 'lm-ico', viewBox: '0 0 16 16', width: 14, height: 14, 'aria-hidden': true },
				h('path', { d: first }),
				h('path', { d: second })
			)
		}

		function LearnmapDock(props) {
			if (typeof props.sessionId !== 'string' || props.sessionId === '') return null
			if (typeof props.useSession !== 'function') {
				return h('div', { className: 'lm-root' }, h('div', { className: 'lm-hint' }, '学习分支图：当前版本的槽位没有提供会话标准 props，面板已跳过。'))
			}
			return h(LearnmapBody, props)
		}

		function LearnmapBody(props) {
			const sessionId = props.sessionId
			const session = props.useSession(snapshot => snapshot) || props.session
			const { tree, windowState, llmConfig, naming, displayName, busy, note, onJump } = useLearnmapSession(sessionId)

			const [open, setOpen] = useState(readOpen)
			const [collapsed, setCollapsed] = useState({})
			const [jumpedId, setJumpedId] = useState(null)

			const toggle = useCallback(() => {
				setOpen(current => {
					writeOpen(!current)
					return !current
				})
			}, [])

			/** 点节点：先记录高亮，再交给共享的跳转。 */
			const jump = useCallback(
				node => {
					setJumpedId(node.id)
					onJump(node)
				},
				[onJump]
			)

			const expandAll = useCallback(() => setCollapsed({}), [])
			const collapseAll = useCallback(() => {
				const next = {}
				const walk = nodes => {
					for (const node of nodes) {
						if (node.children.length > 0) {
							next[node.id] = true
							walk(node.children)
						}
					}
				}
				walk(tree.roots)
				setCollapsed(next)
			}, [tree])

			const renderNode = (node, depth) => {
				const kids = node.children || []
				const hasKids = kids.length > 0
				const isCollapsed = collapsed[node.id] === true
				const isLatest = node.id === tree.latestId
				const row = h(
					'div',
					{ key: 'row', className: 'lm-row', style: { paddingLeft: 6 + depth * 14 + 'px' } },
					hasKids
						? h(
								'button',
								{
									type: 'button',
									className: 'lm-caret',
									title: isCollapsed ? '展开' : '收起',
									onClick: () => setCollapsed(current => Object.assign({}, current, { [node.id]: !isCollapsed }))
								},
								isCollapsed ? '▸' : '▾'
						  )
						: h('span', { className: 'lm-caret lm-caret-leaf' }, ''),
					h(
						'button',
						{
							type: 'button',
							className: 'lm-node' + (isLatest ? ' lm-latest' : '') + (jumpedId === node.id ? ' lm-jumped' : ''),
							title: node.text.length > 300 ? node.text.slice(0, 300) + '…' : node.text,
							onClick: () => jump(node)
						},
						h('span', { className: 'lm-node-label' }, displayName(node)),
						hasKids ? h('span', { className: 'lm-node-count' }, String(kids.length)) : null
					)
				)
				if (!hasKids || isCollapsed || depth >= 12) return row
				return [
					row,
					h(
						'div',
						{ key: 'kids', className: 'lm-kids' },
						kids.map(child => h('div', { key: child.id }, renderNode(child, depth + 1)))
					)
				]
			}

			let body = null
			if (open) {
				if (tree.count === 0) {
					body = h('div', { className: 'lm-hint' }, '还没有可整理的问答：向 agent 提问后，这里会自动长出知识点。')
				} else {
					body = h(
						'div',
						{ className: 'lm-tree' },
						tree.roots.map(root => h('div', { key: root.id }, renderNode(root, 0)))
					)
				}
			}

			return h(
				'div',
				{ className: 'lm-root' },
				h(
					'div',
					{ className: 'lm-bar' },
					h(
						'button',
						{
							type: 'button',
							className: 'lm-title' + (open ? ' lm-title-open' : ''),
							onClick: toggle,
							title: (open ? '收起学习分支图' : '展开学习分支图') + '（' + tree.count + ' 个节点）',
							'aria-expanded': open,
							'aria-label': '学习分支图'
						},
						h('span', { className: 'lm-icon' }, '🌳'),
						h('span', { className: 'lm-label' }, tree.count > 0 ? tree.count + '节点' : '暂无节点'),
						h('span', { className: 'lm-chev' }, open ? '▾' : '▸')
					),
					h(
						'div',
						{ className: 'lm-status' },
						naming.status === 'busy' ? h('span', { className: 'lm-busy' }, '命名中…') : null,
						naming.status === 'failed'
							? h(
									'span',
									{ className: 'lm-busy lm-warn', title: naming.error ? 'LLM 命名失败：' + naming.error : 'LLM 命名失败，已退回规则标题' },
									'命名失败'
							  )
							: null,
						openSidebarGraph !== null
							? h(
									'button',
									{
										type: 'button',
										className: 'lm-icon-btn',
										title: '在右侧栏打开树状图',
										'aria-label': '在右侧栏打开树状图',
										onClick: () => openSidebarGraph && openSidebarGraph()
									},
									iconOpenPanel()
							  )
							: null
					),
					open && tree.count > 0
						? h(
								'div',
								{ className: 'lm-tools' },
								h('button', { type: 'button', className: 'lm-icon-btn', title: '全部展开', 'aria-label': '全部展开', onClick: expandAll }, iconChevrons('down')),
								h('button', { type: 'button', className: 'lm-icon-btn', title: '全部收起', 'aria-label': '全部收起', onClick: collapseAll }, iconChevrons('up')),
								busy ? h('span', { className: 'lm-busy' }, '定位中…') : null
						  )
						: null
				),
				note !== null ? h('div', { className: 'lm-note' }, note) : null,
				body,
				open
					? h(
							'div',
							{ className: 'lm-foot' },
							h('span', null, '点击节点跳回对应提问 · ' + (llmConfig ? '名称由 LLM 生成，分支按规则关联' : '分支按提问术语自动关联')),
							windowState.hasMore ? h('span', { className: 'lm-more' }, '更早的问答尚未加载') : null
					  )
					: null
			)
		}

		// ==============================================================
		// 6. 样式（只用主题 token，跟随明暗主题）
		// ==============================================================

		const CSS = [
			'.lm-root{box-sizing:border-box;width:100%;font-size:12.5px;line-height:1.45;color:var(--dsw-alias-label-primary);font-family:inherit}',
			'.lm-bar{display:flex;align-items:center;gap:8px;padding:2px 2px}',
			'.lm-title{display:inline-flex;align-items:center;gap:6px;height:26px;padding:0 8px;border:1px solid transparent;border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;font:inherit;font-size:12.5px;line-height:1;white-space:nowrap}',
			'.lm-title:hover{background:rgba(127,127,127,.12);border-color:var(--dsw-alias-border-l1);color:var(--dsw-alias-label-primary)}',
			'.lm-title-open{color:var(--dsw-alias-brand-primary)}',
			'.lm-icon{font-size:13px}',
			'.lm-label{font-size:12.5px}',
			'.lm-chev{font-size:10px;color:var(--dsw-alias-label-secondary)}',
			'.lm-tools{display:flex;align-items:center;gap:4px}',
			'.lm-status{display:inline-flex;align-items:center;gap:6px;margin-left:auto}',
			'.lm-warn{color:var(--dsw-alias-state-warn-primary)}',
			'.lm-icon-btn{display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;border:1px solid transparent;border-radius:7px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;padding:0;transition:background .12s,color .12s,border-color .12s}',
			'.lm-ico{display:block;fill:none;stroke:currentColor;stroke-width:1.6;stroke-linecap:round;stroke-linejoin:round}',
			'.lm-tools .lm-icon-btn:hover{border-color:var(--dsw-alias-border-l1)}',
			'.lm-icon-btn:hover{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l1)}',
			'.lm-graph{position:relative;display:flex;flex-direction:column;height:100%;min-height:0;font-size:12.5px;color:var(--dsw-alias-label-primary);font-family:inherit;background:var(--dsw-alias-bg-base)}',
			'.lm-graph-bg{position:absolute;inset:0;pointer-events:none;z-index:0;background-repeat:repeat;background-position:0 0}',
			'.lm-graph-scrim{position:absolute;inset:0;pointer-events:none;z-index:0;background:var(--dsw-alias-bg-base)}',
			'.lm-graph-halo{fill:none;stroke:var(--dsw-alias-brand-primary);stroke-width:4;stroke-linecap:round;stroke-linejoin:round;opacity:.12}',
			'.lm-graph-halo-soft{fill:none;stroke:var(--dsw-alias-bg-base);stroke-width:4.5;stroke-linecap:round;stroke-linejoin:round;opacity:.6}',
			'.lm-graph-settings{position:absolute;right:10px;top:46px;z-index:30;width:228px;display:flex;flex-direction:column;gap:7px;padding:10px;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-overlay);box-shadow:0 12px 30px rgba(0,0,0,.24)}',
			'.lm-set-head{display:flex;align-items:center;justify-content:space-between}',
			'.lm-set-title{font-size:12px;font-weight:600}',
			'.lm-set-x{border:none;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;font:inherit;font-size:11px;padding:0 4px;border-radius:6px}',
			'.lm-set-x:hover{color:var(--dsw-alias-label-primary);background:rgba(127,127,127,.14)}',
			'.lm-set-row{display:flex;align-items:center;gap:5px;flex-wrap:wrap}',
			'.lm-set-label{flex:none;width:34px;font-size:11px;color:var(--dsw-alias-label-secondary)}',
			'.lm-set-group{display:flex;flex-direction:column;gap:6px}',
			'.lm-set-hint{font-size:10.5px;line-height:1.5;color:var(--dsw-alias-label-secondary)}',
			'.lm-set-file{position:absolute;width:1px;height:1px;opacity:0;pointer-events:none}',
			'.lm-set-backdrop{position:absolute;inset:0;z-index:29}',
			'.lm-graph-dropping{outline:2px dashed var(--dsw-alias-brand-primary);outline-offset:-6px}',
			'.lm-graph-drop{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);z-index:5;pointer-events:none;padding:6px 12px;border-radius:999px;background:var(--dsw-alias-bg-overlay);border:1px solid var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary);font-size:11.5px;box-shadow:0 6px 20px rgba(0,0,0,.2)}',
			'.lm-chip{border:1px solid var(--dsw-alias-border-l1);background:transparent;color:var(--dsw-alias-label-secondary);border-radius:999px;padding:1px 9px;font:inherit;font-size:11px;line-height:18px;cursor:pointer;transition:background .12s,color .12s,border-color .12s}',
			'.lm-chip:hover{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l2)}',
			'.lm-chip-on{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary);background:rgba(127,127,127,.12)}',
			'.lm-slider{flex:1;min-width:80px;height:16px;accent-color:var(--dsw-alias-brand-primary);background:transparent}',
			'.lm-tool-on{background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary)}',
			'.lm-graph-canvas{position:absolute;left:0;top:0;z-index:1}',
			'.lm-graph-bar{display:flex;align-items:center;flex-wrap:wrap;gap:6px 8px;padding:9px 12px;border-bottom:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1)}',
			'.lm-graph-title{display:inline-flex;align-items:center;gap:6px;flex:none;font-weight:600;font-size:12.5px;letter-spacing:.01em}',
			'.lm-graph-glyph{font-size:13px;line-height:1}',
			'.lm-graph-count{font-size:11px;color:var(--dsw-alias-label-secondary);background:rgba(127,127,127,.14);border-radius:999px;padding:1px 8px;font-variant-numeric:tabular-nums}',
			'.lm-graph-badge{font-size:10.5px;color:var(--dsw-alias-label-secondary);border:1px solid var(--dsw-alias-border-l1);border-radius:999px;padding:1px 8px}',
			'.lm-badge-action{font:inherit;font-size:10.5px;line-height:16px;background:transparent;cursor:pointer}',
			'.lm-badge-action:hover{color:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary)}',
			'.lm-graph-tools{display:flex;align-items:center;flex-wrap:wrap;gap:1px;margin-left:auto;background:rgba(127,127,127,.10);border-radius:9px;padding:2px}',
			'.lm-tool{border:none;background:transparent;color:var(--dsw-alias-label-secondary);border-radius:7px;padding:2px 8px;font:inherit;font-size:11px;line-height:18px;cursor:pointer;transition:background .12s,color .12s}',
			'.lm-tool:hover{background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary)}',
			'.lm-tool:disabled{opacity:.35;cursor:default;background:transparent;color:var(--dsw-alias-label-secondary)}',
			'.lm-tool-zoom{min-width:46px;text-align:center;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary)}',
			'.lm-tool-sep{width:1px;height:14px;background:var(--dsw-alias-border-l1);margin:0 3px}',
			'.lm-graph-scroll{flex:1;min-height:280px;overflow:hidden;position:relative;touch-action:none;user-select:none;cursor:grab}',
			'.lm-graph-scrolling{cursor:grabbing}',
			'.lm-graph-scrolling .lm-gnode{cursor:grabbing}',
						'.lm-graph-inner{position:relative}',
			'.lm-graph-edges{position:absolute;left:0;top:0;overflow:visible;pointer-events:none}',
			'.lm-graph-edges path{fill:none;stroke:var(--dsw-alias-label-secondary);stroke-width:2;stroke-linecap:round;stroke-linejoin:round}',
			'.lm-graph-edge{stroke-opacity:.9}',
			'.lm-graph-edges path.lm-arrow-head{fill:var(--dsw-alias-label-secondary);stroke:none}',
			'.lm-graph-edges path.lm-graph-link{stroke:var(--dsw-alias-brand-primary);stroke-dasharray:5 4}',
			'.lm-edge-hit{fill:none;stroke:transparent;stroke-width:14;pointer-events:stroke;cursor:pointer}',
			'.lm-graph-edge.lm-edge-selected{stroke:var(--dsw-alias-brand-primary);stroke-opacity:1;stroke-width:2.6}',
			'.lm-gnode{position:absolute;display:flex;align-items:center;box-sizing:border-box;border:1.5px solid color-mix(in srgb,var(--dsw-alias-label-secondary) 32%,var(--dsw-alias-border-l2));border-radius:11px;background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 78%,transparent);backdrop-filter:blur(10px) saturate(1.04);-webkit-backdrop-filter:blur(10px) saturate(1.04);box-shadow:0 5px 16px rgba(15,23,42,.10),inset 0 1px 0 rgba(255,255,255,.32);overflow:visible;touch-action:none;cursor:grab;user-select:none;transition:box-shadow .2s ease,transform .2s ease,border-color .2s ease,background .2s ease}',
			'.lm-gnode:hover{border-color:color-mix(in srgb,var(--dsw-alias-label-secondary) 55%,var(--dsw-alias-border-l2));box-shadow:0 9px 22px rgba(15,23,42,.16),inset 0 1px 0 rgba(255,255,255,.4)}',
			'.lm-gnode-link-target{border-color:var(--dsw-alias-brand-primary);box-shadow:0 0 0 2px color-mix(in srgb,var(--dsw-alias-brand-primary) 55%,transparent),0 8px 22px rgba(15,23,42,.18)}',
			'.lm-gnode-dragging{cursor:grabbing;z-index:6;box-shadow:0 14px 30px rgba(0,0,0,.28);border-color:var(--dsw-alias-brand-primary);transform:none}',
			'.lm-gnode-label{flex:1;min-width:0;display:block;padding:0 28px;overflow:hidden;white-space:normal;word-break:break-word;line-height:20px;font-size:15px;font-weight:500;letter-spacing:.3px}',
			'.lm-gnode-input{flex:1;min-width:0;height:calc(100% - 6px);margin:3px 8px;box-sizing:border-box;border:1px solid var(--dsw-alias-brand-primary);border-radius:7px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;padding:0 6px}',
			'.lm-gnode-input:focus{outline:none;box-shadow:0 0 0 2px rgba(127,127,127,.18)}',
			'.lm-gnode-custom .lm-gnode-label{text-decoration:underline dotted rgba(127,127,127,.65);text-underline-offset:3px}',
			'.lm-gnode-caret{flex:none;width:18px;height:100%;border:none;border-left:1px solid color-mix(in srgb,var(--dsw-alias-border-l1) 60%,transparent);border-radius:0 13px 13px 0;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;font:inherit;font-size:10px;opacity:0;transition:opacity .16s,background .16s,color .16s}',
			'.lm-gnode:hover .lm-gnode-caret,.lm-gnode-caret:focus-visible,.lm-gnode-caret-folded{opacity:.85}',
			'.lm-gnode-caret:hover{opacity:1;color:var(--dsw-alias-label-primary);background:rgba(127,127,127,.12)}',
			'.lm-gnode-caret-folded{opacity:1;color:var(--dsw-alias-brand-primary);background:rgba(127,127,127,.10)}',
			'.lm-gnode-link{position:absolute;left:50%;bottom:-6px;width:11px;height:11px;margin-left:-5.5px;box-sizing:border-box;padding:0;border-radius:50%;border:2px solid var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-base);cursor:crosshair;touch-action:none;opacity:.75;transition:transform .2s ease,opacity .2s ease,background .2s ease}',
			'.lm-gnode-port{position:absolute;left:50%;top:-4px;width:7px;height:7px;margin-left:-3.5px;border-radius:50%;border:1px solid color-mix(in srgb,var(--dsw-alias-border-l2) 80%,transparent);background:color-mix(in srgb,var(--dsw-alias-bg-base) 90%,transparent);pointer-events:none;opacity:.6}',
			'.lm-gnode:hover .lm-gnode-port{opacity:1}',
			'.lm-gnode:hover .lm-gnode-link,.lm-gnode-link:hover,.lm-gnode-link:active{opacity:1;transform:scale(1.25);background:var(--dsw-alias-label-secondary)}',
			'.lm-gnode-link:hover,.lm-gnode-link:active{border-color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-brand-primary)}',
			'.lm-graph-note{padding:7px 12px;color:var(--dsw-alias-brand-primary);font-size:11.5px;background:rgba(127,127,127,.08);border-bottom:1px solid var(--dsw-alias-border-l1)}',
			'.lm-history-note{display:flex;align-items:center;justify-content:space-between;gap:8px}',
			'.lm-history-link{border:none;background:transparent;color:inherit;font:inherit;font-size:11px;padding:0;text-decoration:underline;text-underline-offset:2px;cursor:pointer;opacity:.85}',
			'.lm-history-link:hover{opacity:1}',
			'.lm-graph-hint{padding:7px 12px;border-top:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);font-size:10.5px;line-height:1.5;background:var(--dsw-alias-bg-layer-1)}',
			'.lm-graph-empty{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;padding:24px;text-align:center;min-height:280px}',
			'.lm-graph-empty-glyph{font-size:32px;opacity:.55}',
			'.lm-graph-empty-title{font-size:13px;font-weight:600}',
			'.lm-graph-empty-sub{font-size:11.5px;color:var(--dsw-alias-label-secondary);max-width:260px;line-height:1.6}',
			'.lm-gnode-latest{border-color:var(--dsw-alias-brand-primary);background:color-mix(in srgb,var(--dsw-alias-brand-primary) 14%,var(--dsw-alias-bg-layer-1));box-shadow:0 0 0 1.5px var(--dsw-alias-brand-primary),0 0 20px -2px color-mix(in srgb,var(--dsw-alias-brand-primary) 45%,transparent),0 8px 22px -8px rgba(0,10,30,.3)}',
			'.lm-gnode-latest:hover{box-shadow:0 0 0 1.5px var(--dsw-alias-brand-primary),0 6px 16px rgba(0,0,0,.16)}',
			'.lm-gnode-latest .lm-gnode-label{color:var(--dsw-alias-brand-primary);font-weight:600}',
			'.lm-graph-image .lm-graph-edges path.lm-graph-edge{stroke-opacity:.9}',
			'.lm-graph-image .lm-graph-halo{stroke-width:4.5;opacity:.16}',
			'.lm-graph-image path.lm-arrow-head{fill:var(--dsw-alias-label-secondary)}',
			'.lm-graph-image .lm-gnode{box-shadow:0 6px 18px rgba(0,0,0,.18),0 1px 2px rgba(0,0,0,.12),inset 0 1px 0 rgba(255,255,255,.32)}',
			'.lm-graph-image .lm-gnode:hover{box-shadow:0 10px 26px rgba(0,0,0,.26),inset 0 1px 0 rgba(255,255,255,.4)}',
			'.lm-gnode-picked{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-border-l2)}',
			'.lm-gnode-spacer{flex:none;width:18px}',
			'.lm-gnode-root .lm-gnode-label{font-weight:600}',
			'.lm-busy{font-size:11px;color:var(--dsw-alias-label-secondary)}',
			'.lm-tree{max-height:240px;overflow:auto;margin:2px 0 0;padding:4px 4px 4px 2px;border:1px solid var(--dsw-alias-border-l1);border-radius:9px;background:var(--dsw-alias-bg-layer-1)}',
			'.lm-row{display:flex;align-items:center;gap:1px}',
			'.lm-caret{width:16px;height:22px;flex:none;border:none;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;font:inherit;font-size:10px;padding:0;text-align:center}',
			'.lm-caret-leaf{visibility:hidden;cursor:default}',
			'.lm-node{display:flex;align-items:center;gap:6px;min-width:0;flex:1;text-align:left;border:1px solid transparent;background:transparent;color:var(--dsw-alias-label-primary);border-radius:7px;padding:2px 7px;font:inherit;font-size:12.5px;cursor:pointer}',
			'.lm-node:hover{background:rgba(127,127,127,.13);border-color:var(--dsw-alias-border-l1)}',
			'.lm-node-label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
			'.lm-node-count{flex:none;font-size:10px;color:var(--dsw-alias-label-secondary);background:rgba(127,127,127,.18);border-radius:8px;padding:0 5px;line-height:15px}',
			'.lm-latest .lm-node-label{color:var(--dsw-alias-brand-primary);font-weight:600}',
			'.lm-jumped .lm-node-label{text-decoration:underline;text-decoration-color:var(--dsw-alias-brand-primary)}',
			'.lm-kids{border-left:1px solid var(--dsw-alias-border-l1);margin-left:8px}',
			'.lm-hint{padding:8px 10px;color:var(--dsw-alias-label-secondary);font-size:12px}',
			'.lm-note{padding:4px 10px;color:var(--dsw-alias-state-error-primary);font-size:11.5px;word-break:break-word}',
			'.lm-foot{display:flex;justify-content:space-between;gap:8px;padding:3px 8px 0;color:var(--dsw-alias-label-secondary);font-size:11px}',
			'.lm-more{flex:none}',
			'.lm-flash{animation:lm-flash-pulse 1.8s ease-out;border-radius:8px}',
			'@keyframes lm-flash-pulse{0%{box-shadow:inset 0 0 0 2px var(--dsw-alias-brand-primary)}100%{box-shadow:inset 0 0 0 2px transparent}}'
		].join('')

		/** 插入本插件唯一的样式表；返回清理函数，随插件卸载移除。 */
		function insertStyle() {
			if (typeof document === 'undefined') return () => {}
			let element = document.getElementById(STYLE_ID)
			if (element === null) {
				element = document.createElement('style')
				element.id = STYLE_ID
				element.setAttribute('data-plugin-css', '@learnmap/web-plugin')
				element.textContent = CSS
				document.head.appendChild(element)
			}
			return () => {
				const again = document.getElementById(STYLE_ID)
				if (again !== null && again.textContent === CSS) again.remove()
			}
		}

		// ==============================================================
		// 6.4 手动编辑：改名 / 改父子关系 / 拖动位置
		// ==============================================================
		//
		// 节点 id 是消息 id，全局唯一，所以这一份编辑表不需要按会话分桶：
		//   names[id]     : 自定义名字（压过 LLM 命名与规则标题）
		//   parents[id]   : 改写的父节点 id，或 'root' 表示提为根
		//   positions[id] : 画板坐标 { x, y }（拖动后固定，不再参与自动排布）
		// 全部落在 localStorage；改关系时做环检测，成环的改写会被忽略而不是把树弄坏。

		const EDIT_KEY = 'learnmap.edits.v1'
		const EDIT_LIMIT = 600

		function readEditFile() {
			try {
				const parsed = JSON.parse(readStore(EDIT_KEY) || '{}')
				return parsed && typeof parsed === 'object' ? parsed : {}
			} catch (error) {
				return {}
			}
		}

		const editStore = {
			names: {},
			parents: {},
			positions: {},
			version: 0,
			listeners: new Set(),
			load() {
				const raw = readEditFile()
				this.names = raw.names && typeof raw.names === 'object' ? raw.names : {}
				this.parents = raw.parents && typeof raw.parents === 'object' ? raw.parents : {}
				this.positions = raw.positions && typeof raw.positions === 'object' ? raw.positions : {}
			},
			subscribe(listener) {
				this.listeners.add(listener)
				return () => {
					this.listeners.delete(listener)
				}
			},
			emit() {
				this.version += 1
				for (const listener of Array.from(this.listeners)) {
					try {
						listener()
					} catch (error) {
						console.error('[learnmap] edit listener:', error)
					}
				}
			},
			save() {
				const trim = source => {
					const keys = Object.keys(source)
					if (keys.length <= EDIT_LIMIT) return source
					const kept = {}
					for (const key of keys.slice(keys.length - EDIT_LIMIT)) kept[key] = source[key]
					return kept
				}
				this.names = trim(this.names)
				this.parents = trim(this.parents)
				this.positions = trim(this.positions)
				writeStore(EDIT_KEY, JSON.stringify({ names: this.names, parents: this.parents, positions: this.positions }))
			},
			setName(id, name) {
				const value = String(name || '').trim()
				if (value === '') delete this.names[id]
				else this.names[id] = value.slice(0, 40)
				this.save()
				this.emit()
			},
			setParent(id, parentId) {
				if (parentId === null || parentId === undefined) this.parents[id] = 'root'
				else this.parents[id] = parentId
				this.save()
				this.emit()
			},
			setPosition(id, position) {
				if (!position) delete this.positions[id]
				else this.positions[id] = { x: Math.round(position.x), y: Math.round(position.y) }
				this.save()
				this.emit()
			},
			/** 批量固定坐标：手动连线时冻结当前布局，避免整棵树重排。 */
			setPositions(positions) {
				let changed = false
				for (const id of Object.keys(positions || {})) {
					const point = positions[id]
					if (!point) continue
					this.positions[id] = { x: Math.round(point.x), y: Math.round(point.y) }
					changed = true
				}
				if (!changed) return
				this.save()
				this.emit()
			},
			clearPositions(ids) {
				for (const id of ids) delete this.positions[id]
				this.save()
				this.emit()
			},
			reset(ids) {
				for (const id of ids) {
					delete this.names[id]
					delete this.parents[id]
					delete this.positions[id]
				}
				this.save()
				this.emit()
			}
		}
		editStore.load()

		/** 订阅编辑表（版本号驱动重渲染）。 */
		function useEdits() {
			const [version, setVersion] = useState(editStore.version)
			useEffect(() => editStore.subscribe(() => setVersion(editStore.version)), [])
			return { version, store: editStore }
		}

		/** 把树摊平成 `[{ node, parentId }]`（parentId 为原始关系）。 */
		function flattenTree(roots) {
			const flat = []
			const walk = (nodes, parentId) => {
				for (const node of nodes) {
					flat.push({ node, parentId })
					walk(node.children || [], node.id)
				}
			}
			walk(roots || [], null)
			return flat
		}

		/**
		 * 应用手动编辑：改名 + 改父子关系（含环检测）；位置留给画板。
		 * @param tree - buildTree 的结果。
		 * @param edits - 编辑表（`names` / `parents`）。
		 * @returns 新树；没有任何改写时原样返回。
		 */
		function applyEdits(tree, edits) {
			if (!tree || tree.count === 0) return tree
			const names = edits && edits.names ? edits.names : {}
			const parents = edits && edits.parents ? edits.parents : {}
			if (Object.keys(names).length === 0 && Object.keys(parents).length === 0) return tree

			const flat = flattenTree(tree.roots)
			const original = new Map(flat.map(entry => [entry.node.id, entry.parentId]))
			const effective = id => {
				if (!Object.prototype.hasOwnProperty.call(parents, id)) return original.get(id)
				const override = parents[id]
				return override === 'root' ? null : override
			}
			/** 从 id 沿改写后的父链上溯，看是否会绕回自己（或指向已不存在的节点）。 */
			const safe = id => {
				let cursor = effective(id)
				let guard = 0
				while (cursor !== null && cursor !== undefined && guard < 128) {
					if (cursor === id) return false
					if (!original.has(cursor)) return false
					cursor = effective(cursor)
					guard += 1
				}
				return true
			}

			const nodes = new Map()
			for (const entry of flat) {
				const node = entry.node
				const custom = names[node.id]
				nodes.set(node.id, {
					id: node.id,
					seq: node.seq,
					time: node.time,
					text: node.text,
					label: custom || node.label,
					custom: custom || null,
					children: []
				})
			}

			const roots = []
			for (const entry of flat) {
				const node = nodes.get(entry.node.id)
				const parentId = safe(entry.node.id) ? effective(entry.node.id) : original.get(entry.node.id)
				const parent = parentId ? nodes.get(parentId) : null
				if (parent) parent.children.push(node)
				else roots.push(node)
			}
			const sortRec = list => {
				list.sort((left, right) => (left.seq || 0) - (right.seq || 0))
				for (const node of list) sortRec(node.children)
			}
			sortRec(roots)
			return { roots, count: tree.count, latestId: tree.latestId }
		}

		// ==============================================================
		// 6.4.1 LLM 关系修正（规则建树的兜底）
		// ==============================================================
		//
		// 规则建树便宜、稳定，但会犯错：术语没命中的并列问题容易被串成一条链，
		// 或者被某个泛词吸到不相关的节点下。这里把整棵树的提问 + 回答节选交给一次模型复核，
		// 顶层主题（root）保持不动，只调整非根节点；结果按「节点集合签名」缓存，
		// 手动关系最后应用、永远优先。失败不阻塞，可点「复核」强制重来。

		const RELATIONS_ROUTE = '/learnmap/relations'
		const RELATION_CACHE = 'learnmap.llm.relations.v4'
		const RELATION_CACHE_MAX = 60
		const RELATION_MAX_ITEMS = 80
		const relationInFlight = new Map()

		const relationsStore = {
			parents: {},
			status: 'idle', // idle | busy | failed
			error: null,
			signature: null,
			sessionId: null,
			version: 0,
			listeners: new Set(),
			subscribe(listener) {
				this.listeners.add(listener)
				return () => {
					this.listeners.delete(listener)
				}
			},
			emit() {
				this.version += 1
				for (const listener of Array.from(this.listeners)) {
					try {
						listener()
					} catch (error) {
						console.error('[learnmap] relations listener:', error)
					}
				}
			},
			patch(next) {
				if (next.parents !== undefined) {
					this.parents = next.parents && typeof next.parents === 'object' ? next.parents : {}
				}
				if (next.status !== undefined) this.status = next.status
				if (next.error !== undefined) this.error = next.error
				if (next.signature !== undefined) this.signature = next.signature
				if (next.sessionId !== undefined) this.sessionId = next.sessionId
				this.emit()
			}
		}

		function useRelations() {
			const [version, setVersion] = useState(relationsStore.version)
			useEffect(() => relationsStore.subscribe(() => setVersion(relationsStore.version)), [])
			return {
				version,
				parents: relationsStore.parents,
				status: relationsStore.status,
				error: relationsStore.error,
				signature: relationsStore.signature
			}
		}

		/** 节点集合签名：只由 id + seq + 助手正文长度决定，改名 / 关系变化不触发重新请求。 */
		function relationSignature(tree) {
			const entries = flattenTree(tree.roots)
			return hashText(entries.map(entry => entry.node.id + ':' + (entry.node.seq || 0) + ':' + String(entry.node.assistantText || '').length).join('|'))
		}

		/** 只保留真正改变父节点的条目（root 与 null 等价），用于徽标与技术缓存。 */
		function relationChanges(tree, parents) {
			if (!tree || !parents || typeof parents !== 'object') return {}
			const current = new Map()
			for (const entry of flattenTree(tree.roots)) current.set(entry.node.id, entry.parentId || 'root')
			const out = {}
			for (const id of Object.keys(parents)) {
				if (!current.has(id)) continue
				const value = parents[id]
				if (typeof value !== 'string') continue
				if ((current.get(id) || 'root') === value) continue
				out[id] = value
			}
			return out
		}

		function readRelationCache() {
			try {
				const parsed = JSON.parse(readStore(RELATION_CACHE) || '{}')
				return parsed && typeof parsed === 'object' ? parsed : {}
			} catch (error) {
				return {}
			}
		}

		function writeRelationCache(signature, parents) {
			try {
				const cache = readRelationCache()
				cache[signature] = parents
				const keys = Object.keys(cache)
				if (keys.length > RELATION_CACHE_MAX) {
					const kept = {}
					for (const key of keys.slice(keys.length - RELATION_CACHE_MAX)) kept[key] = cache[key]
					writeStore(RELATION_CACHE, JSON.stringify(kept))
					return
				}
				writeStore(RELATION_CACHE, JSON.stringify(cache))
			} catch (error) {
				// 缓存失败不影响本次展示。
			}
		}

		/**
		 * 应用 LLM 给的父子关系修正。不要求父节点更早（知识树按主题从属，不按提问时间），
		 * 但有两道保险：
		 *   1. **根节点不动**：`parentId === null` 的顶层主题不允许被挂到别的节点下
		 *      （历史事故：根节点被搬到自己的孙节点下，整棵树散架）；非根节点可以带着子树移动；
		 *   2. 环检测：指向自己 / 形成环 / 父节点不存在的建议一律回退原关系。
		 * 手动编辑在之后应用，所以人工关系永远优先。
		 * @param tree - 规则树。
		 * @param parents - `{ [id]: parentId | 'root' }`。
		 * @returns 新树；没有有效修改时原样返回。
		 */
		function applyLlmParents(tree, parents) {
			if (!tree || tree.count === 0 || !parents) return tree
			if (Object.keys(parents).length === 0) return tree
			const entries = flattenTree(tree.roots)
			const known = new Set()
			const original = new Map()
			for (const entry of entries) {
				known.add(entry.node.id)
				original.set(entry.node.id, entry.parentId)
			}
			const chosen = new Map()
			for (const entry of entries) {
				const current = entry.parentId
				let next = current
				// 顶层主题保持不动；只允许有父节点的节点改挂，且必须通过环检测。
				if (current !== null && Object.prototype.hasOwnProperty.call(parents, entry.node.id)) {
					const raw = parents[entry.node.id]
					if (raw === 'root') next = null
					else if (typeof raw === 'string' && raw !== entry.node.id && known.has(raw)) next = raw
				}
				chosen.set(entry.node.id, next)
			}
			// 环检测：沿改写后的父链上溯；绕回自己或指向不存在的节点就回退原关系。
			const effective = id => (chosen.has(id) ? chosen.get(id) : original.get(id))
			const acyclic = id => {
				let cursor = chosen.get(id)
				let guard = 0
				while (cursor !== null && cursor !== undefined && guard < 256) {
					if (cursor === id) return false
					if (!known.has(cursor)) return false
					cursor = effective(cursor)
					guard += 1
				}
				return true
			}
			let changed = false
			for (const entry of entries) {
				const id = entry.node.id
				if (chosen.get(id) !== original.get(id) && !acyclic(id)) chosen.set(id, original.get(id))
				if (chosen.get(id) !== original.get(id)) changed = true
			}
			if (!changed) return tree

			const nodes = new Map()
			for (const entry of entries) {
				nodes.set(entry.node.id, Object.assign({}, entry.node, { children: [] }))
			}
			const roots = []
			for (const entry of entries) {
				const node = nodes.get(entry.node.id)
				const parentId = chosen.get(entry.node.id)
				const parent = parentId ? nodes.get(parentId) : null
				if (parent) parent.children.push(node)
				else roots.push(node)
			}
			const sortRec = list => {
				list.sort((left, right) => (left.seq || 0) - (right.seq || 0))
				for (const node of list) sortRec(node.children)
			}
			sortRec(roots)
			return { roots, count: tree.count, latestId: tree.latestId }
		}

		/** 请宿主复核整棵树的父子关系。 */
		async function requestRelations(items) {
			const res = await fetch(RELATIONS_ROUTE, {
				method: 'POST',
				credentials: 'same-origin',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ items: items.slice(0, RELATION_MAX_ITEMS) })
			})
			if (!res.ok) throw new Error('HTTP ' + res.status)
			const json = await res.json()
			return {
				parents: json && json.parents && typeof json.parents === 'object' ? json.parents : {},
				error: json && typeof json.error === 'string' ? json.error : null
			}
		}

		/**
		 * 驱动一次关系复核：节点集合不变就直接用缓存 / 现有结果。
		 * @param tree - 规则树（不要传已修正的树，否则「保持 parent」会读到修正值）。
		 * @param config - loadLlmConfig() 的结果；`relate: false` 时不动。
		 * @param options - `{ force: true }` 时绕过签名与缓存，供「复核 / 重试」按钮使用。
		 */
		async function driveRelations(tree, config, options) {
			if (!config || config.relate === false) return
			if (!tree || tree.count < 2) return
			const force = options && options.force === true
			const signature = relationSignature(tree)
			if (!force && relationsStore.signature === signature) return
			if (relationInFlight.has(signature)) return relationInFlight.get(signature)
			if (!force) {
				const cache = readRelationCache()
				if (cache[signature] && typeof cache[signature] === 'object') {
					relationsStore.patch({ parents: cache[signature], signature, status: 'idle', error: null })
					return
				}
			}
			relationsStore.patch({ status: 'busy', error: null })
			const items = flattenTree(tree.roots).map(entry => ({
				id: entry.node.id,
				seq: entry.node.seq || 0,
				text: entry.node.text,
				// 助手回答节选：判断“是不是父主题的子类”往往要看它具体讲了什么，不能只看提问。
				answer: String(entry.node.assistantText || '').slice(0, 240),
				parent: entry.parentId || 'root'
			}))
			const task = (async () => {
				try {
					const result = await requestRelations(items)
					// 模型可能把「保持原样」也返回；徽标与缓存只记真正变化的条目。
					const changes = relationChanges(tree, result.parents)
					relationsStore.patch({
						parents: changes,
						signature,
						status: result.error ? 'failed' : 'idle',
						error: result.error
					})
					if (!result.error) writeRelationCache(signature, changes)
				} catch (error) {
					relationsStore.patch({ status: 'failed', error: String((error && error.message) || error), signature })
				} finally {
					relationInFlight.delete(signature)
				}
			})()
			relationInFlight.set(signature, task)
			return task
		}


// 画板底纹：设置项、持久化、样式计算与图片压缩
//
// 底纹画在一个铺满视口的独立图层上（不是节点画布），所以永远覆盖整个空间；
// 点阵通过 background-position/size 跟随 pan/zoom，拖动画板时底纹一起走。

const BOARD_KEY = 'learnmap.board.v1'
const BOARD_DEFAULT = Object.freeze({
	mode: 'dots', // dots | plain | image
	dotSize: 20,
	dotOpacity: 0.18,
	image: '',
	imageOpacity: 0.35,
	imageBlur: 0,
	imageFit: 'cover', // cover | tile
	imageScrim: 0.55, // 图片底图上的遮罩强度：压住画面，连线与箭头才有对比度
	edgeStyle: 'elbow' // elbow（默认，居中垂分）| curve（平滑曲线）
})

/**
 * 图片底图上的遮罩强度（0–0.95）。点阵 / 纯色模式不需要遮罩，返回 0。
 * @param board - 设置。
 * @returns 0–0.95。
 */
function boardScrimOpacity(board) {
	if (!board || board.mode !== 'image') return 0
	const value = typeof board.imageScrim === 'number' ? board.imageScrim : BOARD_DEFAULT.imageScrim
	return Math.max(0, Math.min(0.95, value))
}

function readBoard() {
	try {
		const parsed = JSON.parse(readStore(BOARD_KEY) || '{}')
		if (!parsed || typeof parsed !== 'object') return Object.assign({}, BOARD_DEFAULT)
		const next = Object.assign({}, BOARD_DEFAULT, parsed)
		if (next.mode !== 'dots' && next.mode !== 'plain' && next.mode !== 'image') next.mode = BOARD_DEFAULT.mode
		if (next.imageFit !== 'cover' && next.imageFit !== 'tile') next.imageFit = BOARD_DEFAULT.imageFit
		if (next.edgeStyle !== 'curve' && next.edgeStyle !== 'elbow') next.edgeStyle = BOARD_DEFAULT.edgeStyle
		return next
	} catch (error) {
		return Object.assign({}, BOARD_DEFAULT)
	}
}

/**
 * 画板背景图层的样式（纯函数，便于测试）。
 * @param board - 设置。
 * @param zoom - 当前缩放。
 * @param pan - 当前位移 `{x,y}`。
 * @returns 直接用于 style 的对象。
 */
function boardBackground(board, zoom, pan) {
	const mode = board && board.mode ? board.mode : BOARD_DEFAULT.mode
	if (mode === 'image') {
		if (!board || !board.image) return { backgroundImage: 'none' }
		const tile = board.imageFit === 'tile'
		return {
			backgroundImage: 'url("' + board.image + '")',
			backgroundSize: tile ? 'auto' : 'cover',
			backgroundRepeat: tile ? 'repeat' : 'no-repeat',
			backgroundPosition: 'center',
			opacity: String(typeof board.imageOpacity === 'number' ? board.imageOpacity : BOARD_DEFAULT.imageOpacity),
			filter: board.imageBlur > 0 ? 'blur(' + board.imageBlur + 'px)' : 'none',
			// 模糊会把边缘一起糊掉，所以带模糊时把图层外扩
			inset: board.imageBlur > 0 ? '-24px' : '0px'
		}
	}
	if (mode === 'plain') return { backgroundImage: 'none' }
	const size = Math.max(8, Math.round((board && board.dotSize ? board.dotSize : BOARD_DEFAULT.dotSize) * zoom))
	const alpha = typeof board.dotOpacity === 'number' ? board.dotOpacity : BOARD_DEFAULT.dotOpacity
	return {
		backgroundImage: 'radial-gradient(rgba(127,127,127,' + alpha + ') 1px, transparent 1px)',
		backgroundSize: size + 'px ' + size + 'px',
		backgroundPosition: (pan ? pan.x : 0) + 'px ' + (pan ? pan.y : 0) + 'px',
		backgroundRepeat: 'repeat'
	}
}

/**
 * 把用户选的图片压到可存进 localStorage 的尺寸（长边 ≤ maxSize，JPEG）。
 * @param file - `File`。
 * @param maxSize - 长边像素上限。
 * @param quality - JPEG 质量。
 * @returns dataURL。
 */
function shrinkImage(file, maxSize, quality) {
	return new Promise((resolve, reject) => {
		if (typeof document === 'undefined') {
			reject(new Error('当前环境不支持图片处理'))
			return
		}
		let url = ''
		let image = null
		try {
			url = typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function' ? URL.createObjectURL(file) : ''
			image = new Image()
		} catch (error) {
			reject(error)
			return
		}
		const cleanup = () => {
			try {
				if (url) URL.revokeObjectURL(url)
			} catch (error) {
				/* 忽略 */
			}
		}
		image.onload = () => {
			try {
				const scale = Math.min(1, maxSize / Math.max(1, image.width, image.height))
				const width = Math.max(1, Math.round(image.width * scale))
				const height = Math.max(1, Math.round(image.height * scale))
				const canvas = document.createElement('canvas')
				canvas.width = width
				canvas.height = height
				const context = canvas.getContext('2d')
				if (!context) throw new Error('无法创建绘图上下文')
				context.drawImage(image, 0, 0, width, height)
				const dataUrl = canvas.toDataURL('image/jpeg', quality)
				cleanup()
				resolve(dataUrl)
			} catch (error) {
				cleanup()
				reject(error)
			}
		}
		image.onerror = () => {
			cleanup()
			reject(new Error('无法解码该图片'))
		}
		image.src = url
	})
}
		// ==============================================================
		// 6.5 侧栏树状图（右侧栏标签页）
		// ==============================================================
		//
		// 右侧栏是标签页系统：向 `sidebarRightTabs` 注册一个 tab 类型，把正文挂到
		// keyed 槽位 `sidebar.right.pane.tab`（键 = 类型 id），再用 `sidebarRight.openTab(kind)`
		// 从输入框上方那条细条打开它。图本身是「按层排布 + 贝塞尔连线」的静态 SVG，
		// 不引入图形库，缩放用 CSS transform。

		const ARROW_ID = 'lm-graph-arrow'
		const TAB_ID = '@learnmap/web-plugin/tree'
		const TAB_KIND = 'learnmap'
		// 节点尺寸按内容算：单行放得下就按文字宽度给，放不下才折行加高。
		const NODE_MIN_W = 160
		const NODE_MAX_W = 560
		// 左右内边距(20) + 折叠按钮(18) + 余量：宽度不够就会折行，之前「设置功能」被拆成两行就是这里算少了
		const NODE_PAD = 82
		const NODE_LINE_H = 20
		const NODE_BASE_H = 48
		const GAP_X = 48
		const GAP_Y = 56
		const DEFAULT_BOX = Object.freeze({ w: 176, h: NODE_BASE_H, lines: 1 })

		// 量宽用的字体必须与 .lm-gnode-label 完全一致，否则量出来偏小、渲染时就会折行
		const NODE_FONT = '500 15px system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif'
		const NODE_LETTER_SPACING = 0.3

		/** 打开侧栏图；宿主没有该标签页系统时为 null（面板按钮自动隐藏）。 */
		let openSidebarGraph = null

		// ---- 文字宽度：优先用 canvas 量真实字宽，取不到时按字符类别估算 ----
		let measureCtx
		function measureText(text) {
			const value = String(text || '')
			if (measureCtx === undefined && typeof document !== 'undefined') {
				try {
					const canvas = document.createElement('canvas')
					measureCtx = canvas && typeof canvas.getContext === 'function' ? canvas.getContext('2d') : null
					if (measureCtx) measureCtx.font = NODE_FONT
				} catch (error) {
					measureCtx = null
				}
			}
			if (measureCtx) {
				try {
					return measureCtx.measureText(value).width + value.length * NODE_LETTER_SPACING
				} catch (error) {
					measureCtx = null
				}
			}
			let width = 0
			for (const ch of value) width += (/[\u2e80-\u9fff\uff00-\uffef\u3000-\u303f]/.test(ch) ? 15 : 8.2) + NODE_LETTER_SPACING
			return width
		}

		/**
		 * 一个节点要多宽多高：单行放得下就一行（宽度随文字），超过上限才折成 2–3 行。
		 * @param label - 显示名。
		 * @returns `{ w, h, lines }`。
		 */
		function nodeBox(label) {
			const textWidth = measureText(label)
			const needed = Math.ceil(textWidth) + NODE_PAD
			if (needed <= NODE_MAX_W) return { w: Math.max(NODE_MIN_W, needed), h: NODE_BASE_H, lines: 1 }
			const inner = NODE_MAX_W - NODE_PAD
			const lines = Math.max(2, Math.min(3, Math.ceil(textWidth / inner)))
			return { w: NODE_MAX_W, h: lines * NODE_LINE_H + 22, lines }
		}

		/**
		 * 计算树状图自动布局：叶子按顺序占列（宽度取各自盒子），父节点居中于子节点之上。
		 * 返回「配对」而不是路径字符串 —— 拖动后的实际坐标由调用方决定，边要跟着节点走。
		 * @param roots - buildTree 的根节点。
		 * @param collapsed - `{ [id]: true }` 折叠集合。
		 * @param boxes - `Map<id, {w,h}>`；缺省时用默认尺寸。
		 * @returns `{ nodes, pairs, width, height }`，坐标为自动布局像素。
		 */
		function layoutGraph(roots, collapsed, boxes) {
			const sizeOf = node => (boxes && boxes.get(node.id)) || DEFAULT_BOX
			const nodes = []
			let cursor = 0

			const walk = (node, depth) => {
				const kids = collapsed[node.id] === true ? [] : node.children || []
				const box = sizeOf(node)
				let center
				if (kids.length === 0) {
					center = cursor + box.w / 2
					cursor += box.w + GAP_X
				} else {
					const centers = kids.map(kid => walk(kid, depth + 1))
					center = (centers[0] + centers[centers.length - 1]) / 2
					// 父节点比它整片子树还宽时，把游标推过父节点右缘，避免下一个兄弟压上来
					cursor = Math.max(cursor, center + box.w / 2 + GAP_X)
				}
				// 先保留真实（可能是负的）x；以前在这里 clamp 到 0，宽父节点会被推右，
				// 结果是父节点与窄子节点「左对齐」，单链也凭空多出一个拐弯。走完再整体平移。
				nodes.push({ node, x: center - box.w / 2, y: 0, depth, w: box.w, h: box.h, kids })
				return center
			}
			for (const root of roots) walk(root, 0)

			// 整体右移到最左缘为 0：只做统一平移，父子中心关系不受影响。
			let minX = 0
			for (const item of nodes) if (item.x < minX) minX = item.x
			if (minX < 0) for (const item of nodes) item.x -= minX

			// 每层高度取该层最高节点，纵向按层推进
			const depthHeight = []
			for (const item of nodes) depthHeight[item.depth] = Math.max(depthHeight[item.depth] || 0, item.h)
			const yOf = []
			let y = 0
			for (let depth = 0; depth < depthHeight.length; depth++) {
				yOf[depth] = y
				y += (depthHeight[depth] || NODE_BASE_H) + GAP_Y
			}
			for (const item of nodes) item.y = yOf[item.depth] || 0

			const pairs = []
			for (const item of nodes) {
				for (const kid of item.kids) pairs.push({ from: item.node.id, to: kid.id })
			}
			let width = NODE_MIN_W
			for (const item of nodes) width = Math.max(width, item.x + item.w)
			const lastDepth = depthHeight.length - 1
			const height = lastDepth < 0 ? 0 : yOf[lastDepth] + (depthHeight[lastDepth] || NODE_BASE_H)
			return { nodes, pairs, width, height }
		}

		/**
		 * 以指针为锚点缩放：缩放前后，指针下的画板点保持不动。
		 * 屏幕坐标 = pan + 画板坐标 × zoom，所以新 pan = point − (point − pan) × (to/from)。
		 * @param pan - 当前位移 `{x,y}`。
		 * @param point - 指针在视口内的坐标 `{x,y}`。
		 * @param from - 当前 zoom。
		 * @param to - 目标 zoom。
		 * @returns 新的位移。
		 */
		function zoomAt(pan, point, from, to) {
			const ratio = to / from
			return { x: point.x - (point.x - pan.x) * ratio, y: point.y - (point.y - pan.y) * ratio }
		}

		/**
		 * 父 → 子 的连线。
		 *
		 * 默认走**平滑曲线**：控制点都落在竖直方向，弯的是路径本身，不会多出直角拐点；
		 * 子节点正好在父节点正下方时退化成一条竖线。
		 * style === 'elbow' 时改走竖-横-竖的折线（拐弯压在父节点下方 28px 内）。
		 * @param from - 父节点盒子 `{x,y,w,h}`。
		 * @param to - 子节点盒子 `{x,y,w,h}`。
		 * @param style - 'curve'（默认）或 'elbow'。
		 * @returns SVG path。
		 */
		function edgePath(from, to, style) {
			const x1 = from.x + from.w / 2
			const y1 = from.y + from.h
			const x2 = to.x + to.w / 2
			const y2 = to.y
			const dy = y2 - y1
			// 正下方（单链）：一条竖线，两种样式都一样
			if (Math.abs(x2 - x1) < 1) return `M${x1},${y1} L${x1},${y2}`
			if (style === 'curve') {
				const c = Math.min(Math.max(16, dy * 0.5), 96)
				return `M${x1},${y1} C${x1},${y1 + c} ${x2},${y2 - c} ${x2},${y2}`
			}
			// 默认 T 形垂分：父节点底边中点竖直下落 → 水平母线 → 竖直进入子节点。
			// 母线落在父节点下方约 45% 层距（14–44px），同层兄弟共用同一条；
			// 父节点居中于子节点跨度之上，所以母线天然左右对称。
			const dir = x2 > x1 ? 1 : -1
			const bus = y1 + Math.max(14, Math.min(dy * 0.45, 44))
			const radius = Math.max(2, Math.min(7, Math.abs(x2 - x1) / 2, (y2 - bus) / 2, (bus - y1) / 2))
			return [
				`M${x1},${y1}`,
				`L${x1},${bus - radius}`,
				`Q${x1},${bus} ${x1 + dir * radius},${bus}`,
				`L${x2 - dir * radius},${bus}`,
				`Q${x2},${bus} ${x2},${bus + radius}`,
				`L${x2},${y2}`
			].join(' ')
		}


		/**
		 * 折叠控件的状态：始终以**节点真实的子节点**为准。
		 * 布局结果里的 `kids` 是「当前可见的子节点」——节点收起后它就是空的，
		 * 若拿它判断要不要渲染折叠按钮，按钮会随收起一起消失，节点就再也展不开。
		 * @param node - 树节点。
		 * @param collapsed - `{ [id]: true }` 折叠集合。
		 * @returns `{ hasKids, collapsed, hidden }`，hidden 为收起时隐藏的子节点数。
		 */
		function graphNodeState(node, collapsed) {
			const kids = node.children || []
			const isCollapsed = collapsed[node.id] === true
			return { hasKids: kids.length > 0, collapsed: isCollapsed, hidden: isCollapsed ? kids.length : 0 }
		}

		/**
		 * 补全历史的分页终止条件（纯函数，便于测试）。
		 * 每页是 DSH 的 Turn 对齐分页（≥50 条消息 / ≥2 个 turn），所以页数与耗时都要设上限；
		 * 连续两页没拿到新 revision 视为「卡住」，主动停下，交给用户决定是否继续。
		 * @param state - `{ hasMore, stop, pages, stalls, startedAt, now, maxPages, maxMs }`。
		 * @returns `{ done, reason }`，reason 为 complete / stopped / pages / time / stalled / ''。
		 */
		function historyPagingDone(state) {
			if (state.hasMore !== true) return { done: true, reason: 'complete' }
			if (state.stop === true) return { done: true, reason: 'stopped' }
			if (state.pages >= state.maxPages) return { done: true, reason: 'pages' }
			if (state.now - state.startedAt >= state.maxMs) return { done: true, reason: 'time' }
			if (state.stalls >= 2) return { done: true, reason: 'stalled' }
			return { done: false, reason: '' }
		}

		/** 侧栏图的标签正文。 */
		function GraphBody(props) {
			if (typeof props.sessionId !== 'string' || props.sessionId === '' || typeof props.useSession !== 'function') {
				return h('div', { className: 'lm-graph' }, h('div', { className: 'lm-hint' }, '学习分支图：当前标签没有会话上下文。'))
			}
			return h(GraphSurface, props)
		}

		function GraphSurface(props) {
			const sessionId = props.sessionId
			props.useSession(snapshot => snapshot)
			const { binding, windowState, tree, llmConfig, naming, relations, relationStatus, relationChecked, relationError, recheckRelations, displayName, onJump, editVersion } = useLearnmapSession(sessionId)
			const [collapsed, setCollapsed] = useState({})
			const [zoom, setZoom] = useState(1)
			const [pickedId, setPickedId] = useState(null)
			const [dragging, setDragging] = useState(null) // { id, x, y } 拖动中的临时坐标
			const [linking, setLinking] = useState(null) // { from, x, y } 正在改父子关系的连线
			const [linkTarget, setLinkTarget] = useState(null) // 连线拖拽时悬停的合法目标节点
			const [selectedEdge, setSelectedEdge] = useState(null) // { from, to } 点选中的连线
			const [editing, setEditing] = useState(null) // { id, value } 正在改名的节点
			const [note, setNote] = useState(null)
			// 首次打开侧栏图时补齐「更早的问答」：DSH 的事件窗口是分页的（≥50 条消息 / ≥2 个 turn），
			// 长会话首屏往往只剩最近 5 个提问；这里主动往前翻页直到 hasMore=false。
			const [historyBusy, setHistoryBusy] = useState(false)
			const [historyPages, setHistoryPages] = useState(0)
			const [historyStopped, setHistoryStopped] = useState(false)
			const historyRef = React.useRef({ key: null, stop: false, unmounted: false, running: false })
			const [panning, setPanning] = useState(false)
			const [manualZoom, setManualZoom] = useState(false)
			// 画板用「位移 + 缩放」实现平移，不依赖滚动条：
			// 侧栏容器高度常常是 auto，滚动条不会出现，改 scrollLeft 也不会有任何效果。
			const [pan, setPan] = useState({ x: 16, y: 16 })
			const viewRef = React.useRef(null)
			const canvasRef = React.useRef(null)
			const dragRef = React.useRef(null)
			const linkRef = React.useRef(null)
			const panRef = React.useRef(null)
			const zoomRef = React.useRef(zoom)
			zoomRef.current = zoom
			const panStateRef = React.useRef(pan)
			panStateRef.current = pan

			// ---- 画板底纹设置（点阵 / 纯色 / 自定义图片）----
			const [board, setBoard] = useState(readBoard)
			const [showSettings, setShowSettings] = useState(false)
			const [uploading, setUploading] = useState(false)
			const fileRef = React.useRef(null)
			const updateBoard = useCallback(patch => {
				setBoard(previous => {
					const next = Object.assign({}, previous, patch)
					try {
						writeStore(BOARD_KEY, JSON.stringify(next))
					} catch (error) {
						// 图片太大触发配额时只保留在内存里
					}
					return next
				})
			}, [])
			const bgStyle = useMemo(() => boardBackground(board, zoom, pan), [board, zoom, pan])

			const nodeById = useMemo(() => {
				const map = new Map()
				const walk = nodes => {
					for (const node of nodes) {
						map.set(node.id, node)
						walk(node.children || [])
					}
				}
				walk(tree.roots)
				return map
			}, [tree])

			// 每个节点按自己的显示名算尺寸：名字越长节点越宽（到上限才折行），
			// 「字显示不全」不再靠省略号糊过去。
			const boxes = useMemo(() => {
				const map = new Map()
				const walk = nodes => {
					for (const node of nodes) {
						map.set(node.id, nodeBox(displayName(node)))
						walk(node.children || [])
					}
				}
				walk(tree.roots)
				return map
				// naming.version：命名结果到达后重新量宽度
			}, [tree, naming.version])

			const layout = useMemo(() => layoutGraph(tree.roots, collapsed, boxes), [tree, collapsed, boxes])

			/** 自动坐标 + 手动固定坐标的合成结果；画布尺寸按实际盒子撑大。 */
			const placed = useMemo(() => {
				const map = new Map()
				let width = layout.width
				let height = layout.height
				for (const item of layout.nodes) {
					const pin = editStore.positions[item.node.id]
					const x = pin ? pin.x : item.x
					const y = pin ? pin.y : item.y
					map.set(item.node.id, { x, y, w: item.w, h: item.h, item })
					width = Math.max(width, x + item.w + GAP_X)
					height = Math.max(height, y + item.h + GAP_Y)
				}
				return { map, width, height }
				// editVersion：拖动提交后重新取固定坐标
			}, [layout, editVersion])

			/** 手动改关系前先把当前坐标钉住：连线/断开时不再整棵树重排，像画板一样稳定。 */
			const pinLayout = useCallback(() => {
				const positions = {}
				for (const [id, point] of placed.map) positions[id] = { x: point.x, y: point.y }
				editStore.setPositions(positions)
			}, [placed])

			/** 真实父子连线（带箭头）与拖拽中的预览线分开存，预览线是虚线、不带箭头。 */
			const edges = useMemo(() => {
				const out = []
				for (const pair of layout.pairs) {
					const from = placed.map.get(pair.from)
					const to = placed.map.get(pair.to)
					if (from && to) out.push({ path: edgePath(from, to, board.edgeStyle), from: pair.from, to: pair.to })
				}
				return out
			}, [layout, placed, board.edgeStyle])

			const previewPath = useMemo(() => {
				if (!linking) return null
				const from = placed.map.get(linking.from)
				if (!from) return null
				const x1 = from.x + from.w / 2
				const y1 = from.y + from.h
				return `M${x1},${y1} C${x1},${y1 + 30} ${linking.x},${linking.y - 30} ${linking.x},${linking.y}`
			}, [placed, linking])

			const labelOf = useCallback(
				id => {
					const node = nodeById.get(id)
					return node ? displayName(node) : id
				},
				[nodeById, displayName, naming.version]
			)

			const flashNote = useCallback(text => {
				setNote(text)
				setTimeout(() => setNote(null), 4000)
			}, [])

			/** 撤销本轮 LLM 关系修正（恢复规则关系）；签名也清掉，徽标归零，不立刻重算。 */
			const dismissRelations = useCallback(() => {
				if (Object.keys(relationsStore.parents).length === 0) return
				relationsStore.patch({ parents: {}, signature: null, status: 'idle', error: null })
				flashNote('已撤销 LLM 关系修正，恢复规则关系；需要时可点「复核」重新请求。')
			}, [flashNote])

			/** 能否把 from 挂到 targetId 下：不能挂自己、不能挂到自己的子孙（成环）。 */
			const canLink = useCallback(
				(fromId, targetId) => {
					if (!targetId || targetId === fromId) return false
					const start = nodeById.get(fromId)
					if (!start) return false
					const stack = [start]
					while (stack.length > 0) {
						const node = stack.pop()
						for (const kid of node.children || []) {
							if (kid.id === targetId) return false
							stack.push(kid)
						}
					}
					return true
				},
				[nodeById]
			)

			/** 断开一条连线：子节点提为顶层；先钉住当前布局，避免整棵树突然重排。 */
			const detachEdge = useCallback(
				edge => {
					if (!edge) return
					const entry = flattenTree(tree.roots).find(item => item.node.id === edge.to)
					if (!entry || entry.parentId !== edge.from) {
						setSelectedEdge(null)
						return
					}
					pinLayout()
					editStore.setParent(edge.to, null)
					setSelectedEdge(null)
					flashNote('已断开「' + labelOf(edge.to) + '」的父连线；点「重排」恢复自动排列。')
				},
				[tree, pinLayout, labelOf, flashNote]
			)

			// 点击连线选中后，Delete / Backspace 断开；Esc 取消选中或取消正在拖的连线。
			useEffect(() => {
				if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return undefined
				const onKey = event => {
					if (event.key === 'Escape') {
						if (linkRef.current !== null) {
							linkRef.current = null
							setLinking(null)
							setLinkTarget(null)
						} else {
							setSelectedEdge(null)
						}
						return
					}
					if (event.key !== 'Delete' && event.key !== 'Backspace') return
					if (!selectedEdge) return
					const active = typeof document !== 'undefined' ? document.activeElement : null
					const tag = active && active.tagName ? String(active.tagName).toUpperCase() : ''
					if (tag === 'INPUT' || tag === 'TEXTAREA' || (active && active.isContentEditable)) return
					event.preventDefault()
					detachEdge(selectedEdge)
				}
				window.addEventListener('keydown', onKey)
				return () => window.removeEventListener('keydown', onKey)
			}, [selectedEdge, detachEdge])

			/** 真正的适宽动作：不改「手动缩放」标记。 */
			const fitCore = useCallback(() => {
				const box = viewRef.current
				const available = box && box.clientWidth ? box.clientWidth - 28 : 320
				const next = Math.max(0.18, Math.min(1, available / Math.max(1, placed.width)))
				setZoom(next)
				setPan({ x: 16, y: 16 })
			}, [placed.width])

			/** 用户点了「适宽 / 百分比 / 滚轮」之后就不再自动校正。 */
			const fit = useCallback(() => {
				setManualZoom(true)
				fitCore()
			}, [fitCore])

			// 用户没手动缩放过时持续校正：侧栏往往很窄，不缩放只能看到卡片左半截。
			// 首帧视口宽度可能是 0，所以用 ResizeObserver 等它真的量到宽度再校正。
			useEffect(() => {
				if (manualZoom) return
				const view = viewRef.current
				if (!view) return
				const correct = () => {
					const available = (view.clientWidth || 0) - 24
					if (available > 60 && placed.width > available) fitCore()
				}
				correct()
				if (typeof ResizeObserver === 'function') {
					const observer = new ResizeObserver(correct)
					observer.observe(view)
					return () => observer.disconnect()
				}
				const frame = requestAnimationFrame(correct)
				return () => cancelAnimationFrame(frame)
			}, [placed.width, manualZoom, fitCore])

			// ---- 自动补全更早的问答 ----
			// 只做「往前翻一页」这一件宿主已经支持的事：session.loadOlder()（与聊天里的「加载更早」同一入口）。
			// 图本身就是整段会话的视图，所以侧栏图挂载时自动跑到 hasMore=false；页数/时间都设上限，
			// 超限就停下并给出「继续加载」，避免超长会话一次把几万条事件拉进内存。
			const loadRemainingHistory = useCallback(async () => {
				const session = binding && binding.session
				if (!session || typeof session.loadOlder !== 'function') return
				if (historyRef.current.running) return
				historyRef.current.running = true
				historyRef.current.stop = false
				setHistoryBusy(true)
				setHistoryStopped(false)
				setHistoryPages(0)
				let pages = 0
				let stalls = 0
				const startedAt = Date.now()
				const MAX_PAGES = 24
				const MAX_MS = 45000
				try {
					while (true) {
						const before = readWindow(binding)
						const decision = historyPagingDone({
							hasMore: before.hasMore,
							stop: historyRef.current.stop,
							pages,
							stalls,
							startedAt,
							now: Date.now(),
							maxPages: MAX_PAGES,
							maxMs: MAX_MS
						})
						if (decision.done) break
						const revision = before.revision
						try {
							await session.loadOlder()
						} catch (error) {
							break
						}
						// loadOlder 内部已经 await 整页 prepend；这里再等事件窗口真的发布新 revision。
						// 期间如果聊天面板也在翻页，它的那一页同样会让 revision 前进，算作有效进展。
						let waited = 0
						while (!historyRef.current.stop && waited < 8000) {
							const now = readWindow(binding)
							if (now.revision !== revision || !now.hasMore) break
							await sleep(120)
							waited += 120
						}
						const after = readWindow(binding)
						if (after.revision === revision && after.hasMore) {
							stalls += 1
							await sleep(400)
							continue
						}
						stalls = 0
						pages += 1
						if (!historyRef.current.unmounted) setHistoryPages(pages)
						await sleep(40)
					}
				} finally {
					historyRef.current.running = false
					if (!historyRef.current.unmounted) {
						setHistoryBusy(false)
						if (readWindow(binding).hasMore) setHistoryStopped(true)
					}
				}
			}, [binding])

			// 组件卸载后别再 setState；循环本身靠 stop 结束。
			useEffect(() => {
				historyRef.current.unmounted = false
				return () => {
					historyRef.current.unmounted = true
					historyRef.current.stop = true
				}
			}, [])

			// 窗口可能比图晚就绪：hasMore 从 false 变 true 时也要补一次。
			useEffect(() => {
				if (windowState.hasMore !== true) return
				if (!binding || !binding.session || typeof binding.session.loadOlder !== 'function') return
				// 同一个会话只自动跑一次；看完（hasMore=false）自然就不再进来。
				const key = String(sessionId || '')
				if (historyRef.current.key === key) return
				historyRef.current.key = key
				loadRemainingHistory()
			}, [windowState.hasMore, binding, sessionId, loadRemainingHistory])

			const stopHistory = useCallback(() => {
				historyRef.current.stop = true
				setHistoryStopped(true)
			}, [])

			const resumeHistory = useCallback(() => {
				historyRef.current.key = null
				loadRemainingHistory()
			}, [loadRemainingHistory])

			const allIds = useCallback(() => Array.from(nodeById.keys()), [nodeById])

			const expandAll = useCallback(() => setCollapsed({}), [])
			const collapseAll = useCallback(() => {
				const next = {}
				const walk = nodes => {
					for (const node of nodes) {
						if (node.children.length > 0) {
							next[node.id] = true
							walk(node.children)
						}
					}
				}
				walk(tree.roots)
				setCollapsed(next)
			}, [tree])

			const relayout = useCallback(() => {
				editStore.clearPositions(allIds())
				flashNote('已恢复自动布局（父子关系不变；要重新请模型复核请点「复核」）。')
			}, [allIds, flashNote])

			const resetEdits = useCallback(() => {
				editStore.reset(allIds())
				setEditing(null)
				relationsStore.patch({ parents: {}, signature: null, status: 'idle', error: null })
				if (llmConfig && llmConfig.relate !== false) {
					flashNote('已清除手动编辑，正在重新复核关系…')
					recheckRelations()
				} else {
					flashNote('已清除本会话的改名与关系改写。')
				}
			}, [allIds, flashNote, llmConfig, recheckRelations])

			/** 屏幕坐标 → 画板坐标（画板是 scale 变换过的，所以要除以 zoom）。 */
			const toCanvas = useCallback(
				(clientX, clientY) => {
					const inner = canvasRef.current
					if (!inner) return { x: 0, y: 0 }
					const rect = inner.getBoundingClientRect()
					return { x: (clientX - rect.left) / zoom, y: (clientY - rect.top) / zoom }
				},
				[zoom]
			)

			// ---- 平移画板：左键拖空白处、或任意位置按住中键 ----
			const onBoardPointerDown = event => {
				const middle = event.button === 1
				const left = event.button === 0
				if (!middle && !left) return
				setSelectedEdge(null)
				const target = event.target
				const onNode = target && typeof target.closest === 'function' && target.closest('[data-lm-node]')
				// 左键落在节点上交给节点自己拖；中键始终平移（也顺手压掉中键自动滚动）
				if (left && onNode) return
				if (linkRef.current !== null) return
				if (middle && typeof event.preventDefault === 'function') event.preventDefault()
				if (event.currentTarget && typeof event.currentTarget.setPointerCapture === 'function') {
					event.currentTarget.setPointerCapture(event.pointerId)
				}
				panRef.current = {
					startX: event.clientX,
					startY: event.clientY,
					x: panStateRef.current.x,
					y: panStateRef.current.y
				}
				setPanning(true)
			}
			const onBoardPointerMove = event => {
				const start = panRef.current
				if (!start) return
				setPan({ x: start.x + (event.clientX - start.startX), y: start.y + (event.clientY - start.startY) })
			}
			const onBoardPointerUp = () => {
				if (panRef.current === null) return
				panRef.current = null
				setPanning(false)
			}

			/** Ctrl/⌘ + 滚轮缩放（以指针为锚点），普通滚轮平移画板。 */
			useEffect(() => {
				const view = viewRef.current
				if (!view || typeof view.addEventListener !== 'function') return undefined
				const onWheel = event => {
					const currentZoom = zoomRef.current
					const rect = view.getBoundingClientRect()
					const pointX = event.clientX - rect.left
					const pointY = event.clientY - rect.top
					if (event.ctrlKey || event.metaKey) {
						event.preventDefault()
						const step = event.deltaY > 0 ? -0.1 : 0.1
						const nextZoom = Math.max(0.3, Math.min(1.8, Math.round((currentZoom + step) * 100) / 100))
						if (nextZoom === currentZoom) return
						setPan(previous => zoomAt(previous, { x: pointX, y: pointY }, currentZoom, nextZoom))
						setManualZoom(true)
						setZoom(nextZoom)
						return
					}
					event.preventDefault()
					setPan(previous => ({ x: previous.x - event.deltaX, y: previous.y - event.deltaY }))
				}
				view.addEventListener('wheel', onWheel, { passive: false })
				return () => view.removeEventListener('wheel', onWheel)
			}, [])

			const pick = useCallback(
				node => {
					setPickedId(node.id)
					onJump(node)
				},
				[onJump]
			)

			// ---- 拖动节点：移动位置；没移动就是点击（跳转） ----
			const onNodePointerDown = (event, id) => {
				if (editing || event.button !== 0) return
				const point = placed.map.get(id)
				if (!point) return
				event.currentTarget.setPointerCapture(event.pointerId)
				dragRef.current = {
					id,
					startX: event.clientX,
					startY: event.clientY,
					originX: point.x,
					originY: point.y,
					moved: false
				}
			}
			const onNodePointerMove = event => {
				const drag = dragRef.current
				if (!drag) return
				const dx = (event.clientX - drag.startX) / zoom
				const dy = (event.clientY - drag.startY) / zoom
				if (!drag.moved && Math.abs(dx) < 4 && Math.abs(dy) < 4) return
				drag.moved = true
				setDragging({ id: drag.id, x: drag.originX + dx, y: drag.originY + dy })
			}
			const onNodePointerUp = event => {
				const drag = dragRef.current
				dragRef.current = null
				if (!drag) return
				const dx = (event.clientX - drag.startX) / zoom
				const dy = (event.clientY - drag.startY) / zoom
				setDragging(null)
				if (drag.moved) {
					editStore.setPosition(drag.id, { x: drag.originX + dx, y: drag.originY + dy })
					return
				}
				// 双击的第一下不跳转（第二下会走双击改名）
				if (event.detail > 1) return
				const node = nodeById.get(drag.id)
				if (node) pick(node)
			}

			// ---- 连线改父子关系：从节点底部圆点拖到目标节点（或空白处提为根） ----
			const linkTargetAt = event => {
				const hit = document.elementFromPoint(event.clientX, event.clientY)
				const host = hit && typeof hit.closest === 'function' ? hit.closest('[data-lm-node]') : null
				return host ? host.getAttribute('data-lm-node') : null
			}
			const onLinkPointerDown = (event, id) => {
				if (event.button !== 0) return
				event.stopPropagation()
				event.preventDefault()
				const point = placed.map.get(id)
				if (!point) return
				event.currentTarget.setPointerCapture(event.pointerId)
				linkRef.current = id
				setLinking({ from: id, x: point.x + point.w / 2, y: point.y + point.h + 24 })
			}
			const onLinkPointerMove = event => {
				if (linkRef.current === null) return
				const point = toCanvas(event.clientX, event.clientY)
				setLinking(current => (current ? { from: current.from, x: point.x, y: point.y } : current))
				const targetId = linkTargetAt(event)
				const next = canLink(linkRef.current, targetId) ? targetId : null
				setLinkTarget(current => (current === next ? current : next))
			}
			const onLinkPointerUp = event => {
				const from = linkRef.current
				linkRef.current = null
				if (from === null) return
				setLinking(null)
				setLinkTarget(null)
				const targetId = linkTargetAt(event)
				if (targetId === null || targetId === '') {
					// 拖到空白 = 断开父连线，节点提为顶层；先钉住布局避免整棵树重排。
					pinLayout()
					editStore.setParent(from, null)
					flashNote('已断开父连线，提为顶层；点「重排」恢复自动排列。')
					return
				}
				if (targetId === from) {
					flashNote('不能把节点挂到自己身上。')
					return
				}
				if (!canLink(from, targetId)) {
					flashNote('不能挂到自己的子节点下（会形成环）。')
					return
				}
				pinLayout()
				editStore.setParent(from, targetId)
				flashNote('已把「' + labelOf(from) + '」挂到「' + labelOf(targetId) + '」下，并固定当前布局。')
			}

			// ---- 双击改名 ----
			const startRename = node => {
				setEditing({ id: node.id, value: node.custom || displayName(node) })
			}
			const commitRename = () => {
				const current = editing
				if (!current) return
				setEditing(null)
				editStore.setName(current.id, current.value)
			}

			const header = h(
				'div',
				{ className: 'lm-graph-bar' },
				h('span', { className: 'lm-graph-title' }, h('span', { className: 'lm-graph-glyph' }, '🌳'), '学习分支图'),
				h('span', { className: 'lm-graph-count' }, tree.count > 0 ? tree.count + ' 节点' : '空'),
				naming.status === 'busy' ? h('span', { className: 'lm-graph-badge' }, '命名中…') : null,
				naming.status === 'failed'
					? h('span', { className: 'lm-graph-badge lm-warn', title: naming.error || '' }, '命名失败')
					: null,
				llmConfig ? null : h('span', { className: 'lm-graph-badge' }, '规则命名'),
				llmConfig && llmConfig.relate !== false
					? relationStatus === 'busy'
						? h('span', { className: 'lm-graph-badge' }, '关系复核中…')
						: relationStatus === 'failed'
							? h(
									'button',
									{
										type: 'button',
										className: 'lm-graph-badge lm-badge-action lm-warn',
										onClick: recheckRelations,
										title: relationError || '关系复核失败，点击重试'
									},
									'复核失败 · 重试'
							  )
							: relations && Object.keys(relations).length > 0
								? h(
										'button',
										{
											type: 'button',
											className: 'lm-graph-badge lm-badge-action',
											onClick: dismissRelations,
											title: '点击撤销 LLM 关系修正，恢复规则关系'
										},
										'关系已校正 · 撤销'
								  )
								: relationChecked
									? h('span', { className: 'lm-graph-badge', title: 'LLM 已复核，认为规则关系无需调整' }, '关系已核对')
									: null
					: null,
				h(
					'div',
					{ className: 'lm-graph-tools' },
					h('button', { type: 'button', className: 'lm-tool', onClick: expandAll, title: '展开所有分支' }, '展开'),
					h('button', { type: 'button', className: 'lm-tool', onClick: collapseAll, title: '收起所有分支' }, '收起'),
					h('button', { type: 'button', className: 'lm-tool', onClick: relayout, title: '清除手动位置，恢复自动布局（不改父子关系）' }, '重排'),
					h('button', { type: 'button', className: 'lm-tool', onClick: resetEdits, title: '清除手动编辑，并重新请 LLM 复核关系' }, '还原'),
					h('button', {
						type: 'button',
						className: 'lm-tool',
						disabled: !llmConfig || llmConfig.relate === false || relationStatus === 'busy',
						onClick: recheckRelations,
						title: '重新请 LLM 复核父子关系（绕过缓存）'
					}, '复核'),
					h('button', {
						type: 'button',
						className: 'lm-tool',
						disabled: selectedEdge === null,
						onClick: () => detachEdge(selectedEdge),
						title: '断开选中连线的父子关系（Delete）；子节点变成顶层'
					}, '断开'),
					h('span', { className: 'lm-tool-sep' }),
					h('button', { type: 'button', className: 'lm-tool', onClick: () => { setManualZoom(true); setZoom(value => Math.max(0.18, Math.round((value - 0.1) * 10) / 10)) }, title: '缩小（Ctrl+滚轮）' }, '−'),
					h('button', { type: 'button', className: 'lm-tool lm-tool-zoom', onClick: fit, title: '适宽并归位（双击空白同效）' }, Math.round(zoom * 100) + '%'),
					h('button', { type: 'button', className: 'lm-tool', onClick: () => { setManualZoom(true); setZoom(value => Math.min(1.8, Math.round((value + 0.1) * 10) / 10)) }, title: '放大（Ctrl+滚轮）' }, '+'),
					h('span', { className: 'lm-tool-sep' }),
					h('button', { type: 'button', className: 'lm-tool' + (showSettings ? ' lm-tool-on' : ''), title: '画板外观设置', 'aria-expanded': showSettings, onClick: () => setShowSettings(value => !value) }, '⚙')
				)
			)

			const hint = h(
				'div',
				{ className: 'lm-graph-hint' },
				'拖空白 / 中键平移 · Ctrl+滚轮缩放 · 双击空白适宽 · 拖节点改位置 · 双击节点改名 · 拖底部圆点改父子关系 · 点连线选中后 Delete 断开'
			)


			const [dragOver, setDragOver] = useState(false)

			/**
			 * 应用一张图片做底纹：校验类型 → 压到长边 1600px 的 JPEG → 存本机。
			 * 文件选择、拖拽、粘贴三条入口共用这一段。
			 */
			const applyImageFile = useCallback(
				async file => {
					if (!file) return
					const type = String(file.type || '')
					const named = String(file.name || '')
					const looksImage = type.indexOf('image/') === 0 || /\.(png|jpe?g|webp|gif|bmp)$/i.test(named)
					if (!looksImage) {
						flashNote('只支持图片文件（PNG / JPEG / WebP / GIF）。')
						return
					}
					setUploading(true)
					try {
						const dataUrl = await shrinkImage(file, 1600, 0.82)
						updateBoard({ image: dataUrl, mode: 'image' })
						flashNote('已应用自定义底图。')
					} catch (error) {
						flashNote('图片处理失败：' + String((error && error.message) || error))
					} finally {
						setUploading(false)
					}
				},
				[updateBoard, flashNote]
			)

			const onPickImage = useCallback(
				event => {
					const input = event && event.target
					const file = input && input.files && input.files[0]
					if (input) input.value = ''
					applyImageFile(file)
				},
				[applyImageFile]
			)

			// 直接把图片拖进画板
			const onDragOverBoard = event => {
				if (!event || !event.dataTransfer) return
				event.preventDefault()
				if (!dragOver) setDragOver(true)
			}
			const onDragLeaveBoard = () => setDragOver(false)
			const onDropBoard = event => {
				if (!event || !event.dataTransfer) return
				event.preventDefault()
				setDragOver(false)
				const file = event.dataTransfer.files && event.dataTransfer.files[0]
				if (file) applyImageFile(file)
			}

			// 复制一张图后 Ctrl+V 直接当底纹
			useEffect(() => {
				if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return undefined
				const onPaste = event => {
					// 正在输入框/编辑器里粘贴时别抢：否则往聊天框贴图会顺手把画板底图换了
					const active = typeof document !== 'undefined' ? document.activeElement : null
					const tag = active && active.tagName ? String(active.tagName).toUpperCase() : ''
					if (tag === 'INPUT' || tag === 'TEXTAREA' || (active && active.isContentEditable)) return
					const items = event.clipboardData && event.clipboardData.items
					if (!items) return
					for (const item of items) {
						if (item.kind === 'file' && String(item.type || '').indexOf('image/') === 0) {
							const file = typeof item.getAsFile === 'function' ? item.getAsFile() : null
							if (file) {
								event.preventDefault()
								applyImageFile(file)
								return
							}
						}
					}
				}
				window.addEventListener('paste', onPaste)
				return () => window.removeEventListener('paste', onPaste)
			}, [applyImageFile])
			const chip = (label, active, onClick) =>
				h('button', { type: 'button', className: 'lm-chip' + (active ? ' lm-chip-on' : ''), onClick }, label)

			const settings = showSettings
				? h(
						'div',
						{ className: 'lm-graph-settings' },
						h(
							'div',
							{ className: 'lm-set-head' },
							h('span', { className: 'lm-set-title' }, '画板外观'),
							h('button', { type: 'button', className: 'lm-set-x', title: '关闭', onClick: () => setShowSettings(false) }, '✕')
						),
						h(
							'div',
							{ className: 'lm-set-row' },
							h('span', { className: 'lm-set-label' }, '连线'),
							chip('折线', board.edgeStyle !== 'curve', () => updateBoard({ edgeStyle: 'elbow' })),
							chip('曲线', board.edgeStyle === 'curve', () => updateBoard({ edgeStyle: 'curve' }))
							),
							h(
								'div',
								{ className: 'lm-set-row' },
							h('span', { className: 'lm-set-label' }, '底纹'),
							chip('点阵', board.mode === 'dots', () => updateBoard({ mode: 'dots' })),
							chip('纯色', board.mode === 'plain', () => updateBoard({ mode: 'plain' })),
							chip('图片', board.mode === 'image', () => updateBoard({ mode: 'image' }))
						),
						board.mode === 'dots'
							? h(
									'div',
									{ className: 'lm-set-row' },
									h('span', { className: 'lm-set-label' }, '密度'),
									chip('细', board.dotSize === 14, () => updateBoard({ dotSize: 14 })),
									chip('中', board.dotSize === 20, () => updateBoard({ dotSize: 20 })),
									chip('粗', board.dotSize === 26, () => updateBoard({ dotSize: 26 }))
							  )
							: null,
						board.mode === 'dots'
							? h(
									'div',
									{ className: 'lm-set-row' },
									h('span', { className: 'lm-set-label' }, '深浅'),
									h('input', {
										className: 'lm-slider',
										type: 'range',
										min: '0.06',
										max: '0.6',
										step: '0.02',
										value: String(board.dotOpacity),
										onChange: event => updateBoard({ dotOpacity: Number(event.target.value) })
									})
							  )
							: null,
						board.mode === 'image'
							? h(
									'div',
									{ className: 'lm-set-group' },
									h(
										'div',
										{ className: 'lm-set-row' },
										h(
											'button',
											{ type: 'button', className: 'lm-tool', onClick: () => fileRef.current && fileRef.current.click() },
											uploading ? '处理中…' : board.image ? '更换图片' : '选择图片'
										),
										board.image
											? h('button', { type: 'button', className: 'lm-tool', onClick: () => updateBoard({ image: '' }) }, '移除')
											: null
									),
									h(
										'div',
										{ className: 'lm-set-row' },
										h('span', { className: 'lm-set-label' }, '遮罩'),
										h('input', {
											className: 'lm-slider',
											type: 'range',
											min: '0',
											max: '0.95',
											step: '0.05',
											value: String(board.imageScrim),
											onChange: event => updateBoard({ imageScrim: Number(event.target.value) })
										})
									),
									h(
										'div',
										{ className: 'lm-set-row' },
										h('span', { className: 'lm-set-label' }, '透明度'),
										h('input', {
											className: 'lm-slider',
											type: 'range',
											min: '0.05',
											max: '1',
											step: '0.05',
											value: String(board.imageOpacity),
											onChange: event => updateBoard({ imageOpacity: Number(event.target.value) })
										})
									),
									h(
										'div',
										{ className: 'lm-set-row' },
										h('span', { className: 'lm-set-label' }, '模糊'),
										h('input', {
											className: 'lm-slider',
											type: 'range',
											min: '0',
											max: '12',
											step: '1',
											value: String(board.imageBlur),
											onChange: event => updateBoard({ imageBlur: Number(event.target.value) })
										})
									),
									h(
										'div',
										{ className: 'lm-set-row' },
										h('span', { className: 'lm-set-label' }, '铺法'),
										chip('铺满', board.imageFit === 'cover', () => updateBoard({ imageFit: 'cover' })),
										chip('平铺', board.imageFit === 'tile', () => updateBoard({ imageFit: 'tile' }))
									),
									board.image ? null : h('div', { className: 'lm-set-hint' }, '支持 PNG / JPEG / WebP / GIF；也可直接把图片拖进画板，或复制后 Ctrl+V 粘贴。会自动压到长边 1600px 存本机。')
							  )
							: null,
						h('div', { className: 'lm-set-hint' }, '只改画板外观，不影响节点、连线与编辑记录。')
				  )
				: null

			const settingsBackdrop = showSettings
				? h('div', { className: 'lm-set-backdrop', onClick: () => setShowSettings(false) })
				: null

			const fileInput = h('input', {
				ref: fileRef,
				type: 'file',
				accept: '.png,.jpg,.jpeg,.webp,.gif,image/png,image/jpeg,image/webp,image/gif',
				className: 'lm-set-file',
				onChange: onPickImage
			})
			if (tree.count === 0) {
				return h(
					'div',
					{ className: 'lm-graph' + (board.mode === 'image' && board.image ? ' lm-graph-image' : '') },
					header,
					settingsBackdrop,
					settings,
					fileInput,
					h(
						'div',
						{ className: 'lm-graph-empty' },
						h('div', { className: 'lm-graph-empty-glyph' }, '🌳'),
						h('div', { className: 'lm-graph-empty-title' }, '还没有可整理的问答'),
						h('div', { className: 'lm-graph-empty-sub' }, '向 agent 提问后，这里会长出可拖动、可改名、可改关系的节点图')
					),
					hint
				)
			}
			const canvas = h(
				'div',
				{ className: 'lm-graph-canvas' },
				h(
					'div',
					{
						className: 'lm-graph-inner',
						ref: canvasRef,
						style: {
							width: placed.width,
							height: placed.height,
							transform: 'translate(' + pan.x + 'px, ' + pan.y + 'px) scale(' + zoom + ')',
							transformOrigin: '0 0'
						}
					},
					h(
						'svg',
						{ className: 'lm-graph-edges', width: placed.width, height: placed.height, 'aria-hidden': true },
						h(
							'defs',
							null,
							h(
								'marker',
								{
									id: ARROW_ID,
									viewBox: '0 0 12 12',
									refX: 11,
									refY: 6,
									markerWidth: 12,
									markerHeight: 12,
									markerUnits: 'userSpaceOnUse',
									orient: 'auto'
								},
								h('path', { className: 'lm-arrow-head', d: 'M1,1 L11,6 L1,11 Z' })
							)
						),
						edges.map((edge, index) => h('path', { key: 's' + index, className: 'lm-graph-halo-soft', d: edge.path })),
						edges.map((edge, index) => {
							const selected = selectedEdge !== null && selectedEdge.from === edge.from && selectedEdge.to === edge.to
							return h('path', {
								key: 'e' + index,
								className: 'lm-graph-edge' + (selected ? ' lm-edge-selected' : ''),
								d: edge.path,
								markerEnd: `url(#${ARROW_ID})`
							})
						}),
						// 透明加宽的命中层：2px 的线太难点，单独铺 14px 的 stroke 接收点击。
						edges.map((edge, index) =>
							h('path', {
								key: 'h' + index,
								className: 'lm-edge-hit',
								d: edge.path,
								onPointerDown: event => {
									event.stopPropagation()
									setSelectedEdge({ from: edge.from, to: edge.to })
								}
							})
						),
						previewPath !== null ? h('path', { key: 'preview', className: 'lm-graph-link', d: previewPath }) : null
					),
					layout.nodes.map(item => {
						const id = item.node.id
						const point = placed.map.get(id) || item
						const live = dragging && dragging.id === id ? { x: dragging.x, y: dragging.y, w: point.w, h: point.h } : point
						// 折叠控件必须看「节点真实的子节点」，不能看布局里可见的 kids：
						// 收起后 kids 为空，按 kids 判断会让按钮本身消失，节点就再也展不开。
						const fold = graphNodeState(item.node, collapsed)
						const hasKids = fold.hasKids
						const isCollapsed = fold.collapsed
						const isEditing = editing !== null && editing.id === id
						const classes =
							'lm-gnode' +
							(id === tree.latestId ? ' lm-gnode-latest' : '') +
							(pickedId === id ? ' lm-gnode-picked' : '') +
							(dragging && dragging.id === id ? ' lm-gnode-dragging' : '') +
							(linkTarget === id ? ' lm-gnode-link-target' : '') +
							(nodeById.get(id) && nodeById.get(id).custom ? ' lm-gnode-custom' : '') +
							(item.depth === 0 ? ' lm-gnode-root' : '')
						return h(
							'div',
							{
								key: id,
								className: classes,
								'data-lm-node': id,
								style: { left: live.x, top: live.y, width: live.w, height: live.h },
								title: item.node.text,
								onPointerDown: event => onNodePointerDown(event, id),
								onPointerMove: onNodePointerMove,
								onPointerUp: onNodePointerUp,
								onDoubleClick: () => startRename(item.node)
							},
							isEditing
								? h('input', {
										className: 'lm-gnode-input',
										autoFocus: true,
										value: editing.value,
										onChange: event => setEditing({ id, value: event.target.value }),
										onBlur: commitRename,
										onPointerDown: event => event.stopPropagation(),
										onKeyDown: event => {
											if (event.key === 'Enter') commitRename()
											if (event.key === 'Escape') setEditing(null)
										}
								  })
								: h('span', { className: 'lm-gnode-label' }, displayName(item.node)),
							hasKids && !isEditing
								? h(
										'button',
										{
											type: 'button',
											className: 'lm-gnode-caret' + (isCollapsed ? ' lm-gnode-caret-folded' : ''),
											title: isCollapsed ? '展开 ' + fold.hidden + ' 个分支' : '收起分支',
											'aria-expanded': !isCollapsed,
											onPointerDown: event => event.stopPropagation(),
											onClick: event => {
												event.stopPropagation()
												setCollapsed(current => Object.assign({}, current, { [id]: !isCollapsed }))
											}
										},
										isCollapsed ? '+' + fold.hidden : '−'
								  )
								: isEditing
									? null
									: h('span', { className: 'lm-gnode-spacer' }),
							!isEditing
								? h('button', {
										type: 'button',
										className: 'lm-gnode-link',
										title: '拖到另一个节点：改父子关系；拖到空白处：提为根',
										'aria-label': '拖拽改父子关系',
										onPointerDown: event => onLinkPointerDown(event, id),
										onPointerMove: onLinkPointerMove,
										onPointerUp: onLinkPointerUp
								  })
								: null
						)
					})
				)
			)

			return h(
				'div',
				{ className: 'lm-graph' + (board.mode === 'image' && board.image ? ' lm-graph-image' : '') },
				header,
				settingsBackdrop,
				settings,
				fileInput,
				note !== null ? h('div', { className: 'lm-graph-note' }, note) : null,
				historyBusy
					? h(
							'div',
							{ className: 'lm-graph-note lm-history-note' },
							h('span', null, '正在补全更早的问答… 第 ' + (historyPages + 1) + ' 页'),
							h('button', { type: 'button', className: 'lm-history-link', onClick: stopHistory }, '停止')
					  )
					: historyStopped && windowState.hasMore
						? h(
								'div',
								{ className: 'lm-graph-note lm-history-note' },
								h('span', null, '还有更早的问答未加载'),
								h('button', { type: 'button', className: 'lm-history-link', onClick: resumeHistory }, '继续加载')
						  )
						: null,
				h(
					'div',
					{
						className: 'lm-graph-scroll' + (panning ? ' lm-graph-scrolling' : '') + (dragOver ? ' lm-graph-dropping' : ''),
						ref: viewRef,
						onPointerDown: onBoardPointerDown,
						onPointerMove: onBoardPointerMove,
						onPointerUp: onBoardPointerUp,
						onPointerCancel: onBoardPointerUp,
						onDragOver: onDragOverBoard,
						onDragLeave: onDragLeaveBoard,
						onDrop: onDropBoard,
						onDoubleClick: event => {
							const target = event.target
							if (target && typeof target.closest === 'function' && target.closest('[data-lm-node]')) return
							fit()
						}
					},
					h('div', { className: 'lm-graph-bg', style: bgStyle }),
					h('div', { className: 'lm-graph-scrim', style: { opacity: String(boardScrimOpacity(board)) } }),
					dragOver ? h('div', { className: 'lm-graph-drop' }, '松开：设为画板底图') : null,
					canvas
				),
				hint
			)
		}

		// ==============================================================
		// 7. 插件入口
		// ==============================================================

		const inject = ['slots']

		function apply(ctx) {
			pluginCtx = ctx
			if (!ctx.slots || typeof ctx.slots.inject !== 'function' || typeof ctx.slots.register !== 'function') {
				console.warn('[learnmap] slot 服务不可用：学习分支图未注册')
				return
			}
			try {
				ctx.effect(() => insertStyle(), 'learnmap: stylesheet')
				ctx.slots.inject('conversation.input.dock', () =>
					ctx.slots.register(
						{
							name: 'conversation.input.dock',
							id: 'learnmap',
							order: 15,
							label: () => '学习分支图'
						},
						LearnmapDock
					)
				)
			} catch (error) {
				// 一次注册失败只损失这个面板，不拖垮整个会话页。
				console.warn('[learnmap] 激活失败，跳过学习分支图：', error)
			}

			// 右侧栏标签页：类型注册 + 正文槽位 + 打开动作。缺任一服务就只保留输入框上方那份。
			try {
				if (typeof ctx.inject === 'function') {
					ctx.inject(['sidebarRightTabs', 'sidebarRight'], scope => {
						const tabs = scope.sidebarRightTabs
						const right = scope.sidebarRight
						if (tabs && typeof tabs.register === 'function') {
							ctx.effect(
								() =>
									tabs.register({
										id: TAB_ID,
										kind: TAB_KIND,
										priority: 'extension',
										title: () => '学习分支图'
									}),
								'learnmap: sidebar tab type'
							)
						}
						ctx.slots.inject('sidebar.right.pane.tab', () =>
							ctx.slots.register(
								{ name: 'sidebar.right.pane.tab', key: TAB_ID },
								GraphBody
							)
						)
						if (right && typeof right.openTab === 'function') {
							openSidebarGraph = () => {
								try {
									right.openTab(TAB_KIND)
								} catch (error) {
									console.warn('[learnmap] 打开侧栏树状图失败：', error)
								}
							}
						}
					})
				}
			} catch (error) {
				console.warn('[learnmap] 侧栏标签注册失败，只保留输入框上方面板：', error)
			}
		}

		return { inject, apply }
	}
})
