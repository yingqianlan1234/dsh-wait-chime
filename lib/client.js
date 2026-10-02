/**
 * dsh-wait-chime —— 客户端插件（页面侧）。
 *
 * 宿主（lib/index.js）已经把「助手在等你」编码成一个递增的 seq；这里每秒拉一次
 * /dsh-wait-chime/pending.json，seq 变大就按 gain 播放 say1.ogg；同时在 DSH 设置
 * 面板里注册一个「等待提醒」分区（开关 / 连续响度 / 试听）。
 *
 * 为什么走轮询而不是直接监听会话事件：会话事件在宿主侧，客户端插件走这条同源
 * 相对路径最稳（dsh-app:// 页面下相对路径会被壳转发给 Host）。
 *
 * 四个必须处理的现实问题：
 *   1. 自动播放策略：没有过用户手势时 <audio>.play() 会被 reject，AudioContext
 *      会停在 suspended —— 后者【不报错、只是没声】，所以 Web Audio 未 running
 *      时主动退回 <audio>，靠它的 reject 触发「点一下解锁」提示。
 *   2. 页面刚加载/刷新不该把很久以前的提醒再响一遍 → 首轮只补播「一分钟内发生
 *      且本地没播过」的提醒。
 *   3. 宿主 seq 被重置（状态文件丢失 / 重装）时本地游标会永远大于它，从此静音
 *      → 首轮对齐时把游标回退。
 *   4. 响度要连续可调，但 HTMLAudioElement.volume 上限是 1.0 → 用 Web Audio 的
 *      GainNode（任意小数、可 >1），<audio> 叠放只作兜底。
 *
 * 设置面板走官方插槽 API：exports.inject = ['slots'] +
 * ctx.slots.inject('settings.section', () => ctx.slots.register({...}, () => element))。
 * 拿不到 slots 只跳过面板并告警，提醒功能不受影响。
 */
window.__ModuleLoader__.load({
  id: 'dsh-wait-chime',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    var PENDING_URL = '/dsh-wait-chime/pending.json'
    var CHIME_URL = '/dsh-wait-chime/chime.ogg'
    // 实际播放地址带版本号：宿主那边换过音效就换 URL，浏览器缓存与解码缓存都不会拿到旧的
    var chimeUrl = CHIME_URL + '?v=0'
    var chimeVer = 0
    var decodedUrl = null
    var POLL_MS = 1000
    var CATCHUP_MS = 60000
    var STORE_KEY = 'dshw-wait-played-seq'

    var timer = null
    var playedSeq = 0
    var aligned = false
    var unlockArmed = false

    function readStored() {
      try {
        var v = Number(window.localStorage.getItem(STORE_KEY) || '')
        return isFinite(v) && v >= 0 ? v : 0
      } catch (err) { return 0 }
    }
    function storeSeq(n) {
      try { window.localStorage.setItem(STORE_KEY, String(n)) } catch (err) {}
    }

    // ── 播放：连续增益（Web Audio）优先，叠放兜底 ───────────────────────────
    // HTMLAudioElement.volume 死卡在 1.0，想要【连续且能超过 1】的响度只能用
    // AudioContext + GainNode（增益可任意取小数）。万一 Web Audio 不可用，
    // 回退到"同时播 N 份"的整数台阶方案 —— 至少保证能出声。
    var actx = null
    var decodedBuf = null

    function ensureCtx() {
      try {
        if (!actx) {
          var AC = window.AudioContext || window.webkitAudioContext
          if (AC) actx = new AC()
        }
        if (actx && actx.state === 'suspended' && typeof actx.resume === 'function') {
          try { actx.resume() } catch (err) {}
        }
      } catch (err) { actx = null }
      return actx
    }

    function decodeOnce(ctx) {
      return fetch(chimeUrl)
        .then(function (r) { return r.arrayBuffer() })
        .then(function (ab) {
          return new Promise(function (resolve, reject) {
            var p = ctx.decodeAudioData(ab, resolve, reject)
            if (p && typeof p.then === 'function') p.then(resolve, reject)
          })
        })
    }

    // 预热：页面一启动就把音频解码好，免得第一次提醒因为 fetch+decode 迟到
    function warmUp() {
      var ctx = ensureCtx()
      if (!ctx || typeof ctx.createBufferSource !== 'function' || (decodedBuf && decodedUrl === chimeUrl)) return
      try {
        decodeOnce(ctx).then(function (buf) { decodedBuf = buf; decodedUrl = chimeUrl }).catch(function () {})
      } catch (err) {}
    }

    function playWebAudio(g) {
      var ctx = ensureCtx()
      if (!ctx || typeof ctx.createBufferSource !== 'function') return false
      // AudioContext 没解锁时【不报错、只是静默无声】—— 这种情况宁可退回 <audio>：
      // 它被自动播放策略拦下会 reject，我们据此 armUnlock 提示用户点一下页面。
      if (ctx.state && ctx.state !== 'running') return false
      var fire = function (buf) {
        try {
          var src = ctx.createBufferSource()
          src.buffer = buf
          var gn = ctx.createGain()
          gn.gain.value = Math.max(0, g)
          src.connect(gn)
          gn.connect(ctx.destination)
          src.start(0)
        } catch (err) { playStack(g) }
      }
      if (decodedBuf && decodedUrl === chimeUrl) { fire(decodedBuf); return true }
      try {
        decodeOnce(ctx).then(function (buf) { decodedBuf = buf; decodedUrl = chimeUrl; fire(buf) }).catch(function () { playStack(g) })
      } catch (err) { playStack(g) }
      return true
    }

    function playStack(g) {
      try {
        var n = Math.max(1, Math.min(6, Math.round(g)))
        var each = Math.min(1, g / n)
        for (var i = 0; i < n; i++) {
          try {
            var a = new Audio(chimeUrl)
            a.volume = each
            var p = a.play()
            if (p && typeof p.catch === 'function') {
              p.catch(function (err) {
                console.warn('[dsh-wait-chime] 自动播放被拦下（在页面里点一下即解锁）：' + ((err && err.message) || err))
                armUnlock()
              })
            }
          } catch (err) {}
        }
      } catch (err) {}
    }

    // gain = 幅度倍数，任意小数（1 = 原样，2 = +6dB，0.5 = −6dB）
    function play(gain) {
      var g = (typeof gain === 'number' && gain > 0) ? gain : 1
      try {
        if (!playWebAudio(g)) playStack(g)
      } catch (err) {
        console.warn('[dsh-wait-chime] 播放失败：' + ((err && err.message) || err))
      }
    }

    function armUnlock() {
      if (unlockArmed) return
      unlockArmed = true
      var unlock = function () {
        // 用户手势：同时解除 <audio> 的自动播放限制 + resume AudioContext
        try {
          var ctx = ensureCtx()
          if (ctx && typeof ctx.resume === 'function') { try { ctx.resume() } catch (err) {} }
          warmUp()
        } catch (err) {}
        try {
          var a = new Audio(CHIME_URL)
          a.volume = 0
          var p = a.play()
          if (p && typeof p.then === 'function') {
            p.then(function () { try { a.pause() } catch (err) {} }).catch(function () {})
          }
        } catch (err) {}
        document.removeEventListener('click', unlock, true)
        document.removeEventListener('pointerdown', unlock, true)
        document.removeEventListener('keydown', unlock, true)
      }
      document.addEventListener('click', unlock, true)
      document.addEventListener('pointerdown', unlock, true)
      document.addEventListener('keydown', unlock, true)
    }

    function tick() {
      try {
        fetch(PENDING_URL, { cache: 'no-store' })
          .then(function (r) { return r.json() })
          .then(function (d) {
            if (!d || d.ok !== true || typeof d.seq !== 'number') return
            // 宿主换过音效（版本号变了）→ 换 URL，让解码缓存失效
            var v = d.chime && typeof d.chime.version === 'number' ? d.chime.version : 0
            if (v !== chimeVer) { chimeVer = v; chimeUrl = CHIME_URL + '?v=' + v }
            if (d.enabled === false) {
              // 静音模式：只对齐游标，不发声
              aligned = true
              if (d.seq !== playedSeq) { playedSeq = d.seq; storeSeq(d.seq) }
              return
            }
            if (!aligned) {
              aligned = true
              playedSeq = readStored()
              // 宿主 seq 被重置时（状态文件丢失 / 重装插件），本地游标会永远大于它，
              // 那就再也不出声了 —— 这里把游标对齐回去。
              if (d.seq < playedSeq) { playedSeq = d.seq; storeSeq(d.seq) }
              var fresh = typeof d.ts === 'number' && (Date.now() - d.ts) < CATCHUP_MS
              if (d.seq > playedSeq && fresh) {
                playedSeq = d.seq
                storeSeq(d.seq)
                play(d.gain)
              } else if (d.seq > playedSeq) {
                playedSeq = d.seq
                storeSeq(d.seq)
              }
              return
            }
            if (d.seq > playedSeq) {
              playedSeq = d.seq
              storeSeq(d.seq)
              play(d.volume, d.boost)
            }
          })
          .catch(function () {})
      } catch (err) {}
    }

    function start() {
      if (timer) return
      try { armUnlock() } catch (err) {}
      try { warmUp() } catch (err) {}
      tick()
      timer = setInterval(tick, POLL_MS)
      document.addEventListener('visibilitychange', function () { if (!document.hidden) tick() })
      console.log('[dsh-wait-chime] 等待提醒已启动（助手提问/需要权限时播放 say1.ogg）')
    }

    // ── 官方设置面板分区（slots API）────────────────────────────────────────
    // 与 dsh-plugin-wallpaper-engine 同款用法：
    //   inject ["slots"] → ctx.slots.inject('settings.section', () =>
    //     ctx.slots.register({name,id,order,label}, () => ReactElement))
    // 注册失败只 warn —— 提醒功能本身完全不依赖这个面板。
    var React = null
    try { React = require('react') } catch (err) { React = null }

    // 自报诊断：把「slots/react 是否可用、面板有没有真的渲染」发给宿主，
    // 这样宿主侧能自己判断设置面板为什么没出现，不必翻浏览器控制台。
    function report(info) {
      try {
        fetch('/dsh-wait-chime/client-report.json', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(info),
        }).catch(function () {})
      } catch (err) {}
    }

    function WaitChimeSection() {
      var cfgState = React.useState(null)
      var cfg = cfgState[0]
      var setCfg = cfgState[1]
      var msgState = React.useState('')
      var msg = msgState[0]
      var setMsg = msgState[1]

      React.useEffect(function () {
        var alive = true
        fetch(PENDING_URL, { cache: 'no-store' })
          .then(function (r) { return r.json() })
          .then(function (d) {
            if (!alive || !d || d.ok !== true) return
            setCfg({
              enabled: d.enabled !== false,
              gain: typeof d.gain === 'number' ? d.gain : 2,
              chime: d.chime || null,
            })
          })
          .catch(function () {})
        return function () { alive = false }
      }, [])

      function save(patch) {
        setCfg(function (prev) { return Object.assign({}, prev || {}, patch) })
        fetch('/dsh-wait-chime/config.json', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(patch),
        })
          .then(function (r) { return r.json() })
          .then(function (d) { setMsg(d && d.ok ? '已保存' : '保存失败') })
          .catch(function () { setMsg('保存失败') })
      }

      // 换音效：文件本身当 body 发过去，宿主按【文件头】判断真实格式（扩展名只用于显示）
      function uploadChime(file) {
        try {
          if (!file) return
          if (file.size > 4 * 1024 * 1024) { setMsg('文件超过 4 MB 了'); return }
          setMsg('上传中…')
          fetch('/dsh-wait-chime/chime-upload', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/octet-stream',
              'X-Chime-Name': encodeURIComponent(String(file.name || '')),
            },
            body: file,
          })
            .then(function (r) { return r.json() })
            .then(function (d) {
              if (d && d.ok && d.chime) {
                setCfg(function (prev) { return Object.assign({}, prev || {}, { chime: d.chime }) })
                if (typeof d.chime.version === 'number') { chimeVer = d.chime.version; chimeUrl = CHIME_URL + '?v=' + chimeVer }
                setMsg('已替换为 ' + d.chime.name)
                play(cfg.gain)
              } else {
                setMsg('替换失败：' + ((d && d.error) || '未知错误'))
              }
            })
            .catch(function (e) { setMsg('替换失败：' + ((e && e.message) || e)) })
        } catch (err) { setMsg('替换失败：' + ((err && err.message) || err)) }
      }

      function resetChime() {
        try {
          setMsg('恢复中…')
          fetch('/dsh-wait-chime/chime-reset', { method: 'POST' })
            .then(function (r) { return r.json() })
            .then(function (d) {
              if (d && d.ok && d.chime) {
                setCfg(function (prev) { return Object.assign({}, prev || {}, { chime: d.chime }) })
                chimeVer = d.chime.version || 0
                chimeUrl = CHIME_URL + '?v=' + chimeVer
                setMsg('已恢复内置默认音效')
                play(cfg.gain)
              } else { setMsg('恢复失败') }
            })
            .catch(function () { setMsg('恢复失败') })
        } catch (err) { setMsg('恢复失败') }
      }

      if (!cfg) {
        return React.createElement('div', { style: { padding: '10px 2px', opacity: 0.6 } }, '读取配置中…')
      }

      var row = { display: 'flex', alignItems: 'center', gap: '10px', margin: '12px 0' }
      var tag = { minWidth: '68px', opacity: 0.75 }
      return React.createElement(
        'div',
        { style: { padding: '2px' } },
        React.createElement(
          'div',
          { style: row },
          React.createElement('span', { style: tag }, '提醒音'),
          React.createElement('input', {
            type: 'checkbox',
            checked: cfg.enabled,
            onChange: function (e) { save({ enabled: !!e.target.checked }) },
          }),
          React.createElement('span', { style: { opacity: 0.6 } }, cfg.enabled ? '开启（助手提问 / 需要权限时响）' : '已静音'),
        ),
        React.createElement(
          'div',
          { style: row },
          React.createElement('span', { style: tag }, '响度'),
          React.createElement('input', {
            type: 'range',
            min: 0.5,
            max: 6,
            step: 0.1,
            value: cfg.gain,
            disabled: !cfg.enabled,
            style: { width: '190px' },
            onChange: function (e) { save({ gain: Number(e.target.value) }) },
          }),
          React.createElement('span', null, '×' + (Math.round(cfg.gain * 10) / 10) + '（' + (cfg.gain >= 1 ? '+' : '') + (20 * Math.log(cfg.gain) / Math.LN10).toFixed(1) + ' dB）'),
        ),
        React.createElement(
          'div',
          { style: row },
          React.createElement('span', { style: tag }, '音效'),
          React.createElement('input', {
            type: 'file',
            accept: '.mp3,.ogg,.opus,.wav,.m4a,.aac,.flac,.webm,audio/*',
            style: { maxWidth: '180px', fontSize: '12px' },
            onChange: function (e) {
              var f = e.target.files && e.target.files[0]
              try { e.target.value = '' } catch (err) {}
              if (f) uploadChime(f)
            },
          }),
          React.createElement('button', { onClick: resetChime }, '恢复默认'),
        ),
        React.createElement(
          'div',
          { style: { margin: '-6px 0 6px 78px', opacity: 0.55, fontSize: '12px', lineHeight: '1.6' } },
          cfg.chime && cfg.chime.custom
            ? '当前：' + cfg.chime.name + '（' + Math.round((cfg.chime.size || 0) / 1024) + ' KB）'
            : '当前：内置默认 say1.ogg',
          React.createElement('br', null),
          '支持 mp3 / ogg / opus / wav / m4a / aac / flac / webm；建议 ≤ 2 MB、1~3 秒的短音效（按文件头识别，改扩展名没用）',
        ),
        React.createElement(
          'div',
          { style: row },
          React.createElement('span', { style: tag }, ''),
          React.createElement('button', { onClick: function () { play(cfg.gain) } }, '试听'),
          React.createElement('span', { style: { opacity: 0.55 } }, msg || '改动即时生效，无需重启'),
        ),
      )
    }

    function apply(ctx) {
      try {
        if (window.__dshWaitChimeStarted) return
        window.__dshWaitChimeStarted = true
        if (typeof document === 'undefined') return
        if (document.readyState === 'loading') {
          document.addEventListener('DOMContentLoaded', start, { once: true })
        } else {
          start()
        }
        // 注册官方设置面板分区（slots API；运行时探测，拿不到就只跳过面板）
        try {
          var slots = (ctx && ctx.slots) || (ctx && typeof ctx.get === 'function' ? ctx.get('slots') : null)
          report({
            stage: 'apply',
            hasCtx: !!ctx,
            hasSlotsProp: !!(ctx && ctx.slots),
            hasGet: !!(ctx && typeof ctx.get === 'function'),
            slotsFound: !!slots,
            hasReact: !!React,
            inject: exports.inject,
          })
          if (React && slots && typeof slots.inject === 'function' && typeof slots.register === 'function') {
            slots.inject('settings.section', function () {
              return slots.register(
                { name: 'settings.section', id: 'dsh-wait-chime', order: 620, label: '等待提醒' },
                function () {
                  report({ stage: 'render', panelRendered: true })
                  return React.createElement(WaitChimeSection)
                },
              )
            })
            console.log('[dsh-wait-chime] 已注册设置面板分区：设置 → 等待提醒')
          } else {
            console.warn('[dsh-wait-chime] slots API 或 react 不可用，跳过设置面板（提醒功能不受影响）')
          }
        } catch (err) {
          console.warn('[dsh-wait-chime] 设置面板注册失败（提醒功能不受影响）：' + ((err && err.message) || err))
        }
        if (ctx && typeof ctx.effect === 'function') {
          ctx.effect(function () {
            return function () {
              try {
                if (timer) clearInterval(timer)
                timer = null
                window.__dshWaitChimeStarted = false
              } catch (err) {}
            }
          })
        }
      } catch (err) {
        console.warn('[dsh-wait-chime] 启动失败：' + ((err && err.message) || err))
      }
    }

    exports.name = 'dsh-wait-chime'
    // 声明 inject ['slots']：这是官方客户端 UI 插槽服务，桌面端确实提供
    // （证据：dsh-plugin-wallpaper-engine 用同一条路径在设置面板里加了分区）。
    // 声明的代价：该服务若缺失，整个客户端插件都不会被加载（连提醒音效一起）——
    // 所以 apply 里仍做运行时探测，注册失败只 warn，提醒功能不受影响。
    exports.inject = ['slots']
    exports.apply = apply
    return module.exports
  }
})
