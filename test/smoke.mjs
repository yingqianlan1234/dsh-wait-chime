/**
 * dsh-wait-chime 冒烟测试：用假的 root/ctx 跑一遍宿主逻辑。
 *   node test/smoke.mjs
 * 目的：重启桌面端之前先确认「事件识别 → seq → 路由响应」这条链是对的。
 */
const os = await import('node:os')
const fs = await import('node:fs')
const path = await import('node:path')
// 用系统临时目录，不污染项目目录（跑完留在 temp 里由系统回收）
process.env.DSH_HOME = path.join(os.tmpdir(), 'dsh-wait-chime-test')
fs.rmSync(process.env.DSH_HOME, { recursive: true, force: true })
// 预置一份配置：验证配置能被读进来（boost 是响度倍数，对外统一用 gain = volume × boost）
fs.mkdirSync(process.env.DSH_HOME, { recursive: true })
fs.writeFileSync(path.join(process.env.DSH_HOME, '.dshw-wait.json'), JSON.stringify({ seq: 0, enabled: true, volume: 0.8, boost: 3 }), 'utf8')

const mod = await import('../lib/index.js')
const { name, inject, apply } = mod

const results = []
function check(label, ok, extra) {
  results.push({ label, ok: !!ok, extra })
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (extra !== undefined ? '  → ' + extra : ''))
}

// ── 假的宿主 ────────────────────────────────────────────────────────────
const handlers = {}
const routes = []
const root = {
  on(ev, fn) { handlers[ev] = fn; return () => { delete handlers[ev] } },
  inject(services, cb) {
    cb({
      webServer: { register(route) { routes.push(route); return () => {} } },
      get: () => null,
      effect: () => {},
    })
  },
}
function fakeRes() {
  return { code: null, headers: null, body: null, writeHead(c, h) { this.code = c; this.headers = h }, end(b) { this.body = b } }
}
function call(pathname, req) {
  const r = routes.find((x) => x.path === pathname)
  if (!r) throw new Error('route missing: ' + pathname)
  const res = fakeRes()
  r.handler(req || { headers: { host: '127.0.0.1:1' }, url: pathname, method: 'GET' }, res)
  return res
}
function pending() { return JSON.parse(call('/dsh-wait-chime/pending.json').body) }
function emit(event) { handlers['session/event']({ id: 's1' }, event) }

// ── 用例 ────────────────────────────────────────────────────────────────
check('导出 name', name === 'dsh-wait-chime', name)
check('inject 为空数组', Array.isArray(inject) && inject.length === 0)
apply(root)
check('订阅了 session/event', typeof handlers['session/event'] === 'function')
check('注册了 7 条路由', routes.length === 7, routes.map((r) => r.path).join(', '))

check('初始 seq = 0', pending().seq === 0, pending().seq)
check('配置读入 volume/boost', pending().volume === 0.8 && pending().boost === 3, 'volume=' + pending().volume + ' boost=' + pending().boost)
check('pending 下发 gain（连续响度）', Math.abs(pending().gain - 2.4) < 1e-6, pending().gain)

// ── 写配置路由（设置面板用）──────────────────────────────────────────────
function fakePost(body, url, extraHeaders) {
  const listeners = {}
  const req = {
    headers: Object.assign({ host: '127.0.0.1:1', 'content-type': 'application/json' }, extraHeaders || {}),
    url: url || '/dsh-wait-chime/config.json',
    method: 'POST',
    on(ev, fn) { listeners[ev] = fn; return req },
    destroy() {},
    flush() {
      if (listeners.data) listeners.data(Buffer.isBuffer(body) ? body : Buffer.from(body))
      if (listeners.end) listeners.end()
    },
  }
  return req
}
const cfgRoute = routes.find((r) => r.path === '/dsh-wait-chime/config.json')
const postReq = fakePost(JSON.stringify({ boost: 4, enabled: true }))
const postRes = fakeRes()
const postDone = cfgRoute.handler(postReq, postRes)
postReq.flush()
await postDone
check('POST config.json 改 boost', pending().boost === 4, postRes.body)
// gain 是设置面板用的连续值：写 gain 会把 volume 归一成 1，避免两个乘数打架
const gReq = fakePost(JSON.stringify({ gain: 2.5 }))
const gRes = fakeRes()
const gDone = cfgRoute.handler(gReq, gRes)
gReq.flush()
await gDone
check('POST config.json 写 gain（连续）', pending().gain === 2.5 && pending().volume === 1, gRes.body)

// ── 替换音效：以文件头为准（伪造扩展名无效）──────────────────────────────
const upRoute = routes.find((r) => r.path === '/dsh-wait-chime/chime-upload')
const upReq = fakePost(Buffer.concat([Buffer.from('OggS'), Buffer.alloc(64)]), '/dsh-wait-chime/chime-upload', { 'x-chime-name': encodeURIComponent('my.ogg') })
const upRes = fakeRes()
const upDone = upRoute.handler(upReq, upRes)
upReq.flush()
await upDone
check('上传 ogg：识别并生效', JSON.parse(upRes.body).ok === true && pending().chime.custom === true && pending().chime.ext === 'ogg', upRes.body)

const badReq = fakePost(Buffer.from('this is definitely not audio data'), '/dsh-wait-chime/chime-upload', { 'x-chime-name': 'fake.mp3' })
const badRes = fakeRes()
const badDone = upRoute.handler(badReq, badRes)
badReq.flush()
await badDone
check('非音频被拒（不看扩展名）', JSON.parse(badRes.body).ok === false, badRes.body)

const rsRoute = routes.find((r) => r.path === '/dsh-wait-chime/chime-reset')
const rsReq = fakePost('', '/dsh-wait-chime/chime-reset')
const rsRes = fakeRes()
const rsDone = rsRoute.handler(rsReq, rsRes)
rsReq.flush()
await rsDone
check('恢复默认音效', JSON.parse(rsRes.body).ok === true && pending().chime.custom === false, rsRes.body)
const getRes = fakeRes()
await cfgRoute.handler({ headers: { host: '127.0.0.1:1' }, url: '/dsh-wait-chime/config.json', method: 'GET' }, getRes)
check('写路由拒绝 GET', JSON.parse(getRes.body).ok === false, getRes.body)

emit({ type: 'assistant/message', data: { turn: 1, usage: {} } })
emit({ type: 'turn/end', data: {} })
check('普通事件不触发提醒', pending().seq === 0, pending().seq)

emit({ type: 'tool/call', data: { name: 'read' } })
check('非等待工具不触发', pending().seq === 0, pending().seq)

emit({ type: 'tool/call', data: { name: 'ask_user_question' }, seq: 42 })
const p1 = pending()
check('ask_user_question 触发提醒', p1.seq === 1 && p1.kind === 'question', JSON.stringify(p1))

// 冷却：1.2 秒内重复事件不重复响
emit({ type: 'tool/call', data: { name: 'ask_user_question' } })
check('冷却期内不重复', pending().seq === 1, pending().seq)

// 审批：真机事件名 approval/asked 触发一次；approval/decided 不该再响
// （先等过冷却窗口，否则测的是冷却而不是识别）
await new Promise((r) => setTimeout(r, 1300))
emit({ type: 'approval/asked', data: {} })
const p2 = pending()
check('approval/asked 触发审批提醒', p2.seq === 2 && p2.kind === 'approval', JSON.stringify(p2))
emit({ type: 'approval/decided', data: {} })
check('approval/decided 不再重复提醒', pending().seq === 2, pending().seq)

// 音频路由
const audio = call('/dsh-wait-chime/chime.ogg')
check('音频路由 200 + audio/ogg', audio.code === 200 && audio.headers['Content-Type'] === 'audio/ogg', audio.code + ' ' + audio.headers['Content-Type'])
check('音频字节与源文件一致', audio.body.length === 7497, audio.body.length + ' bytes')

// 跨站拒绝
const cross = call('/dsh-wait-chime/pending.json', { headers: { host: '127.0.0.1:1', 'sec-fetch-site': 'cross-site' }, url: '/dsh-wait-chime/pending.json', method: 'GET' })
check('cross-site 被拒 403', cross.code === 403, cross.code)

// 诊断
const diag = JSON.parse(call('/dsh-wait-chime/events.json').body)
check('诊断记录了事件类型', diag.types.some((t) => t.type === 'tool/call'), diag.types.map((t) => t.type + ':' + t.count).join(' '))

// 状态落盘
const stateFile = path.join(process.env.DSH_HOME, '.dshw-wait.json')
check('状态已落盘', fs.existsSync(stateFile), stateFile)

console.log('\n' + results.filter((r) => r.ok).length + '/' + results.length + ' 通过')
process.exit(results.every((r) => r.ok) ? 0 : 1)
