/**
 * dsh-wait-chime —— 宿主侧插件。
 *
 * 作用：助手「停下来等你」的时候提醒你一声（真正出声的是页面侧，见 lib/client.js）。
 *   ① 助手向你提问 —— 会话事件 `tool/call`，工具名 `ask_user_question`；
 *   ② 需要额外权限 —— 会话事件 `approval/asked`（真机实测确认）。`approval/decided`
 *      （你已决定）刻意不响，否则一次审批会响两声。
 *   ③ 见过的所有事件类型都写进诊断 `$DSH_HOME/.dshw-wait-events.json`，便于事后排查。
 *
 * 链路：
 *   root.on('session/event') → 命中 → seq++ 落盘 $DSH_HOME/.dshw-wait.json
 *   页面侧每秒拉 /dsh-wait-chime/pending.json → seq 变大 → 按 gain 播放 chime.ogg
 *
 * 路由：pending.json（读状态）/ config.json（写开关与响度）/ chime.ogg（音频字节）/
 *   client-report.json（页面自报诊断）/ events.json（事件类型统计）。
 *   全部拒绝 `Sec-Fetch-Site: cross-site`，且不含任何凭据。
 *
 * 配置热生效：enabled / volume / boost 在每次真提醒前与每秒轮询时重读，
 *   改完最多 1 秒生效，不必重启。
 *
 * 回退：从 profile 的 package.json 的 dsh.profile.bundles 删掉本包一行即彻底停用；
 *   只想静音，把 `$DSH_HOME/.dshw-wait.json` 的 enabled 改成 false。
 *
 * 稳定性约定：apply() 内任何失败都只 warn，绝不抛 —— 插件加载失败不得影响宿主启动。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const CHIME_PATH = path.join(PACKAGE_ROOT, 'assets', 'say1.ogg')
// 用户自己替换的音效存这里 —— 不写进插件包：既不会在升级时被覆盖，也不会弄脏 git 工作区
const CUSTOM_CHIME_DIR = path.join(DSH_HOME, 'dsh-wait-chime')
const CUSTOM_CHIME_BASE = 'chime'
const MAX_CHIME_BYTES = 4 * 1024 * 1024
// 能被 Chromium 解码的音频容器 → MIME。写入时以**文件头嗅探结果**为准，不信扩展名。
const AUDIO_MIME = {
  ogg: 'audio/ogg', opus: 'audio/ogg', mp3: 'audio/mpeg', wav: 'audio/wav',
  m4a: 'audio/mp4', aac: 'audio/aac', flac: 'audio/flac', webm: 'audio/webm',
}
// 给设置面板显示的支持列表（与 AUDIO_MIME 同步）
const AUDIO_ACCEPT = '.mp3,.ogg,.opus,.wav,.m4a,.aac,.flac,.webm,audio/*'
const STATE_PATH = path.join(DSH_HOME, '.dshw-wait.json')
const DIAG_PATH = path.join(DSH_HOME, '.dshw-wait-events.json')

export const name = 'dsh-wait-chime'
export const inject = []

// 会让我「停下来等你」的工具 → 提醒类型
const WAIT_TOOLS = { ask_user_question: 'question' }
// 审批：2026-10-02 真机实测确认 DSH 走会话事件流，事件名是 approval/asked（系统要你决定）
// 与 approval/decided（你已决定）。只在「问你」的那一刻提醒一次 —— decided 再响一次纯属噪音。
const WAIT_EVENTS = { 'approval/asked': 'approval' }
// 连响保护：一次等待里重复的事件/重放不会连成一片
const COOLDOWN_MS = 1200
const DIAG_FLUSH_MS = 5000

export function apply(root) {
  // boost：浏览器把 Audio.volume 卡在 1.0 以下，想更响只能同时播多份（每份约 +6dB）。
  // 默认 2 份 ≈ +6dB，比单份明显；嫌不够可调到 3、4（见 .dshw-wait.json）。
  const state = { seq: 0, last: null, lastFiredAt: 0, enabled: true, volume: 1, boost: 2, chime: null }
  const types = new Map()
  const disposers = []
  let diagTimer = null
  let chimeCache = null
  // 自验证：页面（客户端插件）每秒轮询 pending.json 会带浏览器 UA；
  // PowerShell/curl 探活带的是别的 UA —— 用这个区分「客户端插件是否真的在跑」。
  let pagePolls = 0
  let lastUserAgent = ''
  // 客户端（页面侧）自报的诊断：slots/react 是否可用、设置面板有没有真的渲染。
  // 留着是为了「面板没出现」时能自己定位，不必让用户翻浏览器控制台。
  let clientReports = []

  function warn(msg) { try { console.warn('[dsh-wait-chime] ' + msg) } catch (err) {} }
  function note(msg) { try { console.log('[dsh-wait-chime] ' + msg) } catch (err) {} }

  // ── 状态：seq 持久化，页面/宿主重启后仍能判断「这是新提醒」 ──────────────
  function loadState() {
    try {
      const raw = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'))
      if (raw && typeof raw === 'object') {
        if (Number.isFinite(Number(raw.seq))) state.seq = Math.max(0, Number(raw.seq))
        if (raw.last && typeof raw.last === 'object') state.last = raw.last
        if (typeof raw.enabled === 'boolean') state.enabled = raw.enabled
        if (Number.isFinite(Number(raw.volume))) state.volume = Math.min(1, Math.max(0, Number(raw.volume)))
        if (Number.isFinite(Number(raw.boost))) state.boost = Math.min(6, Math.max(0.2, Number(raw.boost)))
        if (raw.chime && typeof raw.chime === 'object' && typeof raw.chime.ext === 'string' && AUDIO_MIME[raw.chime.ext]) state.chime = raw.chime
      }
    } catch (err) { /* 首次运行没有文件，属正常 */ }
  }
  function saveState() {
    try {
      fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true })
      fs.writeFileSync(STATE_PATH, JSON.stringify({
        seq: state.seq,
        last: state.last,
        enabled: state.enabled,
        volume: state.volume,
        boost: state.boost,
        chime: state.chime,
        updatedAt: new Date().toISOString(),
      }, null, 2), 'utf8')
    } catch (err) { warn('状态落盘失败：' + ((err && err.message) || err)) }
  }

  // 配置热读取：enabled / volume / boost 从文件重读，改完最多 1 秒生效 —— 不必重启。
  // （seq / last 是插件自己维护的状态，不在这里读。）
  let lastTuneAt = 0
  function refreshTuning(force) {
    const now = Date.now()
    if (!force && now - lastTuneAt < 1000) return
    lastTuneAt = now
    try {
      const raw = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'))
      if (raw && typeof raw === 'object') {
        if (typeof raw.enabled === 'boolean') state.enabled = raw.enabled
        if (Number.isFinite(Number(raw.volume))) state.volume = Math.min(1, Math.max(0, Number(raw.volume)))
        if (Number.isFinite(Number(raw.boost))) state.boost = Math.min(6, Math.max(0.2, Number(raw.boost)))
        if (raw.chime && typeof raw.chime === 'object' && typeof raw.chime.ext === 'string' && AUDIO_MIME[raw.chime.ext]) state.chime = raw.chime
      }
    } catch (err) { /* 文件不在或写了一半：沿用当前值 */ }
  }

  // ── 诊断：记录见过的所有事件类型（用于实证「审批」到底有没有事件） ──────
  function noteType(type) {
    types.set(type, (types.get(type) || 0) + 1)
    if (diagTimer) return
    diagTimer = setTimeout(() => {
      diagTimer = null
      try {
        const rows = Array.from(types.entries())
          .map(([type, count]) => ({ type, count }))
          .sort((a, b) => b.count - a.count)
        fs.mkdirSync(path.dirname(DIAG_PATH), { recursive: true })
        fs.writeFileSync(DIAG_PATH, JSON.stringify({ updatedAt: new Date().toISOString(), types: rows }, null, 2), 'utf8')
      } catch (err) { /* 诊断失败不影响功能 */ }
    }, DIAG_FLUSH_MS)
    if (diagTimer && typeof diagTimer.unref === 'function') diagTimer.unref()
  }

  // ── 提醒 ────────────────────────────────────────────────────────────────
  function fire(kind, detail, event) {
    refreshTuning(true) // 真提醒前强制重读配置：改完 json 立刻按新音量响
    const now = Date.now()
    if (now - state.lastFiredAt < COOLDOWN_MS) return
    state.lastFiredAt = now
    state.seq += 1
    state.last = {
      kind,
      detail: String(detail || '').slice(0, 120),
      ts: now,
      seq: event && Number.isFinite(Number(event.seq)) ? Number(event.seq) : null,
    }
    saveState()
    note('等待提醒 #' + state.seq + '：' + kind + (detail ? '（' + detail + '）' : ''))
  }

  function onEvent(event) {
    try {
      if (!event || typeof event !== 'object') return
      const type = typeof event.type === 'string' ? event.type : ''
      if (!type) return
      noteType(type)
      const data = event.data

      if (type === 'tool/call' && data && typeof data === 'object') {
        const toolName = typeof data.name === 'string'
          ? data.name
          : (data.tool && typeof data.tool === 'string' ? data.tool : '')
        const kind = toolName ? WAIT_TOOLS[toolName] : null
        if (kind) { fire(kind, toolName, event); return }
      }

      const waitKind = WAIT_EVENTS[type]
      if (waitKind) { fire(waitKind, type, event); return }
    } catch (err) { /* 单个事件解析失败不允许影响会话 */ }
  }

  // ── 订阅会话事件（不依赖任何服务，立即生效） ────────────────────────────
  loadState()
  try {
    if (typeof root.on === 'function') {
      const off = root.on('session/event', (a, b) => {
        const ev = (b && b.type) ? b : ((a && a.type) ? a : null)
        if (ev) onEvent(ev)
      })
      if (typeof off === 'function') disposers.push(off)
    } else {
      warn('宿主没有 root.on，等待提醒不可用')
    }
  } catch (err) { warn('事件订阅失败：' + ((err && err.message) || err)) }

  // ── 只读路由：状态 / 音频 / 诊断 ────────────────────────────────────────
  function isCrossSite(req) {
    try {
      return String((req && req.headers && req.headers['sec-fetch-site']) || '').toLowerCase() === 'cross-site'
    } catch (err) { return false }
  }
  function noteRequest(req) {
    try {
      const ua = String((req && req.headers && req.headers['user-agent']) || '')
      lastUserAgent = ua.slice(0, 80)
      if (/Chrome|Electron|Safari/i.test(ua)) pagePolls += 1
    } catch (err) {}
  }
  function denied(req, res) {
    if (!isCrossSite(req)) return false
    try { res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('cross-site denied') } catch (err) {}
    return true
  }
  function readBody(req) {
    return new Promise((resolve, reject) => {
      let data = ''
      let size = 0
      req.on('data', (chunk) => {
        size += chunk.length
        if (size > 8192) { try { req.destroy() } catch (err) {} ; reject(new Error('body too large')); return }
        data += chunk
      })
      req.on('end', () => resolve(data))
      req.on('error', reject)
    })
  }
  // 二进制版读体（上传音效用）：readBody 是字符串拼接，会把二进制弄坏
  function readBodyBuffer(req, limit) {
    return new Promise((resolve, reject) => {
      const chunks = []
      let size = 0
      req.on('data', (chunk) => {
        size += chunk.length
        if (size > limit) {
          try { req.destroy() } catch (err) {}
          reject(new Error('文件过大（上限 ' + Math.round(limit / 1048576) + ' MB）'))
          return
        }
        chunks.push(chunk)
      })
      req.on('end', () => resolve(Buffer.concat(chunks)))
      req.on('error', reject)
    })
  }
  // 按文件头判断真实容器 —— 只放行 Chromium 真能解码的格式（扩展名可以随便填）
  function sniffAudio(buf) {
    try {
      if (!buf || buf.length < 12) return null
      const at = (o, s) => buf.toString('latin1', o, o + s.length) === s
      if (at(0, 'OggS')) return 'ogg'                      // ogg vorbis / opus
      if (at(0, 'fLaC')) return 'flac'
      if (at(0, 'RIFF') && at(8, 'WAVE')) return 'wav'
      if (at(0, 'ID3')) return 'mp3'
      if (buf[0] === 0xFF && (buf[1] & 0xE0) === 0xE0) return 'mp3' // 无 ID3 的裸 MP3 帧同步
      if (at(4, 'ftyp')) return 'm4a'                       // m4a / mp4 音频
      if (buf[0] === 0x1A && buf[1] === 0x45 && buf[2] === 0xDF && buf[3] === 0xA3) return 'webm'
      return null
    } catch (err) { return null }
  }
  function customChimePath() {
    const c = state.chime
    if (!c || !c.ext || !AUDIO_MIME[c.ext]) return null
    return path.join(CUSTOM_CHIME_DIR, CUSTOM_CHIME_BASE + '.' + c.ext)
  }
  function chimeInfo() {
    const c = state.chime
    if (c && c.ext && AUDIO_MIME[c.ext]) {
      return {
        custom: true,
        ext: c.ext,
        mime: c.mime || AUDIO_MIME[c.ext],
        size: Number(c.size) || 0,
        name: String(c.name || (CUSTOM_CHIME_BASE + '.' + c.ext)).slice(0, 120),
        version: Number(c.at) || 0,
      }
    }
    return { custom: false, ext: 'ogg', mime: 'audio/ogg', size: 0, name: 'say1.ogg（内置默认）', version: 0 }
  }
  function json(res, body) {
    try {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
      res.end(JSON.stringify(body))
    } catch (err) {}
  }

  try {
    if (typeof root.inject === 'function') {
      root.inject(['webServer'], (ctx) => {
        try {
          const server = ctx && (ctx.webServer || (typeof ctx.get === 'function' ? ctx.get('webServer') : null))
          if (!server || typeof server.register !== 'function') {
            warn('webServer 不可用，等待提醒状态无法被页面读取')
            return
          }
          const register = (route) => {
            try {
              const d = server.register(route)
              if (typeof d === 'function') disposers.push(d)
            } catch (err) { warn('路由注册失败 ' + route.path + '：' + ((err && err.message) || err)) }
          }

          register({
            kind: 'exact',
            path: '/dsh-wait-chime/pending.json',
            handler: (req, res) => {
              if (denied(req, res)) return
              noteRequest(req)
              refreshTuning() // 改完 json 最多 1 秒反映到页面
              json(res, {
                ok: true,
                seq: state.seq,
                kind: state.last ? state.last.kind : null,
                detail: state.last ? state.last.detail : null,
                ts: state.last ? state.last.ts : null,
                enabled: state.enabled,
                volume: state.volume,
                boost: state.boost,
                gain: state.volume * state.boost,
                chime: chimeInfo(),
                accept: AUDIO_ACCEPT,
                maxBytes: MAX_CHIME_BYTES,
              })
            },
          })

          // 写配置：给设置面板（开关 / 响度）用，只在页面里点的时候调用。
          // 安全底线与其它路由一致：拒绝 Sec-Fetch-Site: cross-site（恶意网页的
          // 跨站 POST 会被这条挡住）。这里能改的只有音量与开关，不涉及任何凭据。
          register({
            kind: 'exact',
            path: '/dsh-wait-chime/config.json',
            handler: async (req, res) => {
              if (denied(req, res)) return
              const method = String((req && req.method) || 'GET').toUpperCase()
              if (method !== 'POST' && method !== 'PUT') {
                json(res, { ok: false, error: 'use POST' })
                return
              }
              try {
                const body = await readBody(req)
                const patch = body ? JSON.parse(body) : {}
                refreshTuning(true)
                if (typeof patch.enabled === 'boolean') state.enabled = patch.enabled
                // gain：设置面板用的连续响度（幅度倍数，0.2~6）。收到 gain 就把 volume
                // 归一成 1，让 boost 单独承担增益 —— 免得两个乘数互相打架。
                if (Number.isFinite(Number(patch.gain))) {
                  state.boost = Math.min(6, Math.max(0.2, Number(patch.gain)))
                  state.volume = 1
                }
                if (Number.isFinite(Number(patch.volume))) state.volume = Math.min(1, Math.max(0, Number(patch.volume)))
                if (Number.isFinite(Number(patch.boost))) state.boost = Math.min(6, Math.max(0.2, Number(patch.boost)))
                saveState()
                note('配置更新：enabled=' + state.enabled + ' boost=' + state.boost + ' gain=' + (state.volume * state.boost).toFixed(2))
                json(res, { ok: true, enabled: state.enabled, volume: state.volume, boost: state.boost, gain: state.volume * state.boost })
              } catch (err) {
                json(res, { ok: false, error: String((err && err.message) || err).slice(0, 120) })
              }
            },
          })

          // 客户端自报：GET 读最近几份，POST 追加一份（诊断用，只读信息，无凭据）
          register({
            kind: 'exact',
            path: '/dsh-wait-chime/client-report.json',
            handler: async (req, res) => {
              if (denied(req, res)) return
              const method = String((req && req.method) || 'GET').toUpperCase()
              if (method === 'POST') {
                try {
                  const body = await readBody(req)
                  const info = body ? JSON.parse(body) : {}
                  clientReports.push({ at: new Date().toISOString(), info })
                  if (clientReports.length > 5) clientReports = clientReports.slice(-5)
                } catch (err) { warn('客户端自报解析失败：' + ((err && err.message) || err)) }
              }
              json(res, { ok: true, reports: clientReports })
            },
          })

          // 音效下发：有自定义就用自定义，否则用包内默认。前端地址带 ?v=<version>，
          // 换过音效 URL 就变，浏览器缓存与解码缓存都不会拿到旧的。
          register({
            kind: 'exact',
            path: '/dsh-wait-chime/chime.ogg',
            handler: (req, res) => {
              if (denied(req, res)) return
              try {
                let bytes = null
                let mime = 'audio/ogg'
                const p = customChimePath()
                if (p) {
                  try {
                    bytes = fs.readFileSync(p)
                    mime = state.chime.mime || AUDIO_MIME[state.chime.ext] || 'audio/ogg'
                  } catch (err) { bytes = null } // 文件被删了就静默回落到默认音效
                }
                if (!bytes) {
                  if (!chimeCache) chimeCache = fs.readFileSync(CHIME_PATH)
                  bytes = chimeCache
                  mime = 'audio/ogg'
                }
                res.writeHead(200, {
                  'Content-Type': mime,
                  'Cache-Control': 'no-store',
                  'Content-Length': String(bytes.length),
                })
                res.end(bytes)
              } catch (err) {
                res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' })
                res.end('chime unavailable')
              }
            },
          })

          // 替换音效：原始字节 + X-Chime-Name 头（只用于显示）。
          // 落盘名固定为 chime.<嗅探出的扩展名>，目录固定在 $DSH_HOME 下 —— 不接受任何路径输入。
          register({
            kind: 'exact',
            path: '/dsh-wait-chime/chime-upload',
            handler: async (req, res) => {
              if (denied(req, res)) return
              const method = String((req && req.method) || 'GET').toUpperCase()
              if (method !== 'POST') { json(res, { ok: false, error: 'use POST' }); return }
              try {
                const buf = await readBodyBuffer(req, MAX_CHIME_BYTES)
                if (!buf || !buf.length) { json(res, { ok: false, error: '文件是空的' }); return }
                const ext = sniffAudio(buf)
                if (!ext || !AUDIO_MIME[ext]) {
                  json(res, { ok: false, error: '认不出这个音频格式（支持 mp3 / ogg / opus / wav / m4a / aac / flac / webm）' })
                  return
                }
                let rawName = ''
                try { rawName = decodeURIComponent(String((req.headers && req.headers['x-chime-name']) || '')) } catch (err) { rawName = '' }
                fs.mkdirSync(CUSTOM_CHIME_DIR, { recursive: true })
                // 换格式时清掉同目录下其它扩展名的旧文件，别堆垃圾
                for (const k of Object.keys(AUDIO_MIME)) {
                  if (k === ext) continue
                  try { fs.rmSync(path.join(CUSTOM_CHIME_DIR, CUSTOM_CHIME_BASE + '.' + k), { force: true }) } catch (err) {}
                }
                fs.writeFileSync(path.join(CUSTOM_CHIME_DIR, CUSTOM_CHIME_BASE + '.' + ext), buf)
                refreshTuning(true) // 先重读旧配置，再覆盖 chime 字段
                state.chime = {
                  ext,
                  mime: AUDIO_MIME[ext],
                  size: buf.length,
                  name: rawName ? rawName.slice(0, 120) : (CUSTOM_CHIME_BASE + '.' + ext),
                  at: Date.now(),
                }
                saveState()
                chimeCache = null
                note('音效已替换：' + state.chime.name + '（' + ext + '，' + buf.length + ' 字节）')
                json(res, { ok: true, chime: chimeInfo(), accept: AUDIO_ACCEPT, maxBytes: MAX_CHIME_BYTES })
              } catch (err) {
                json(res, { ok: false, error: String((err && err.message) || err).slice(0, 160) })
              }
            },
          })

          // 恢复默认音效：删掉自定义文件并清空配置
          register({
            kind: 'exact',
            path: '/dsh-wait-chime/chime-reset',
            handler: async (req, res) => {
              if (denied(req, res)) return
              const method = String((req && req.method) || 'GET').toUpperCase()
              if (method !== 'POST') { json(res, { ok: false, error: 'use POST' }); return }
              try {
                const p = customChimePath()
                if (p) { try { fs.rmSync(p, { force: true }) } catch (err) {} }
                state.chime = null
                chimeCache = null
                saveState()
                note('音效已恢复内置默认')
                json(res, { ok: true, chime: chimeInfo() })
              } catch (err) {
                json(res, { ok: false, error: String((err && err.message) || err).slice(0, 160) })
              }
            },
          })

          register({
            kind: 'exact',
            path: '/dsh-wait-chime/events.json',
            handler: (req, res) => {
              if (denied(req, res)) return
              json(res, {
                ok: true,
                updatedAt: new Date().toISOString(),
                pagePolls,
                lastUserAgent,
                types: Array.from(types.entries())
                  .map(([type, count]) => ({ type, count }))
                  .sort((a, b) => b.count - a.count),
              })
            },
          })

          note('路由就绪：/dsh-wait-chime/{pending,config,chime.ogg,chime-upload,chime-reset,client-report,events}.json')
          try {
            if (typeof ctx.effect === 'function') {
              ctx.effect(() => () => {
                for (const d of disposers) { try { d() } catch (err) {} }
              })
            }
          } catch (err) { /* 没有 effect 就不自动卸载，不影响功能 */ }
        } catch (err) { warn('路由装配失败：' + ((err && err.message) || err)) }
      })
    }
  } catch (err) { warn('inject 失败：' + ((err && err.message) || err)) }
}
