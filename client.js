/**
 * dsh-x-scroll —— 浏览器半端（设置页「刷 X」）
 * ============================================================================
 * client bundle 不是 ESM，是**自注册脚本**（跟 dsh-bili-scroll 一样）：
 *   window.__ModuleLoader__.load({ id: '<包名>', factory: (require) => ({ inject, apply }) })
 *
 * 进设置页的写法：
 *   const slots = ctx.get('slots')
 *   slots.inject('settings.section', () => slots.register({ name, id, order, label }, () => h(Panel)))
 * ============================================================================
 */
window.__ModuleLoader__.load({
  id: 'dsh-x-scroll',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement

    const API = '/api/x-duty'
    /* ⚠️ 不要直接 .json()：HTTP 500 的 {ok:false,error} 会被当成"保存成功" */
    const asJson = async (res) => {
      if (res.ok) return res.json()
      const why = res.status === 401 ? '（未登录 / 没权限）' : res.status === 403 ? '（被宿主拦了）' : ''
      throw new Error('HTTP ' + res.status + why)
    }
    const jget = async (p) => asJson(await fetch(API + p, { credentials: 'same-origin' }))
    const jpost = async (p, body) => asJson(await fetch(API + p, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body || {}),
    }))

    const CSS = [
      '[data-x-page]{display:flex;flex-direction:column;gap:14px;padding:2px 2px 12px;max-width:680px;}',
      '[data-x-sec]{display:flex;flex-direction:column;gap:10px;padding:12px 14px;border-radius:12px;',
      '  border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.10));',
      '  background:var(--dsw-alias-bg-overlay,rgba(128,128,128,.06));}',
      '[data-x-h]{display:flex;align-items:center;gap:8px;font-size:12px;font-weight:600;letter-spacing:.02em;',
      '  color:var(--dsw-alias-label-secondary,#c9ccd1);}',
      '[data-x-h]::before{content:attr(data-dot);font-size:11px;opacity:.55;}',
      '[data-x-row]{display:flex;align-items:center;gap:10px;flex-wrap:wrap;min-width:0;}',
      '[data-x-grow]{flex:1 1 160px;min-width:0;}',
      '[data-x-label]{font-size:13px;line-height:20px;min-width:0;overflow-wrap:anywhere;}',
      '[data-x-note]{font-size:11px;line-height:17px;color:var(--dsw-alias-label-tertiary,#9aa0a6);overflow-wrap:anywhere;}',
      '[data-x-sw]{flex:none;width:38px;height:22px;border-radius:11px;border:0;cursor:pointer;position:relative;',
      '  background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.35));transition:background .15s;padding:0;}',
      '[data-x-sw][data-on]{background:#3b82f6;}',
      '[data-x-sw] i{position:absolute;top:3px;left:3px;width:16px;height:16px;border-radius:50%;background:#fff;',
      '  transition:left .15s;display:block;}',
      '[data-x-sw][data-on] i{left:19px;}',
      '[data-x-sw][disabled]{opacity:.45;cursor:default;}',
      '[data-x-input]{width:100%;box-sizing:border-box;padding:7px 9px;border-radius:8px;font-size:12px;',
      '  border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.14));',
      '  background:var(--dsw-alias-bg-overlay,rgba(128,128,128,.12));color:inherit;font-family:inherit;}',
      '[data-x-input]:focus{outline:none;border-color:#3b82f6;}',
      '[data-x-row] > [data-x-input]{flex:1 1 190px;width:auto;min-width:0;}',
      '[data-x-row] > [data-x-input][data-x-num]{flex:0 0 96px;width:96px;text-align:center;margin-left:auto;}',
      '[data-x-row] > [data-x-btn]{flex:none;}',
      '[data-x-wrap]{flex:1 0 100%;display:flex;flex-direction:column;gap:6px;min-width:0;}',
      '[data-x-area]{min-height:92px;resize:vertical;line-height:19px;}',
      '[data-x-num]{width:96px;text-align:center;}',
      '[data-x-btn]{padding:7px 12px;border-radius:8px;font-size:12px;cursor:pointer;font-family:inherit;',
      '  border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.16));',
      '  background:var(--dsw-alias-bg-overlay,rgba(128,128,128,.14));color:inherit;transition:background .15s;}',
      '[data-x-btn]:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.24));}',
      '[data-x-btn][data-primary]{background:#3b82f6;border-color:#3b82f6;color:#fff;}',
      '[data-x-btn][disabled]{opacity:.5;cursor:default;}',
      '[data-x-msg]{flex:1 1 100%;font-size:11px;line-height:16px;padding:7px 9px;border-radius:8px;',
      '  overflow-wrap:anywhere;background:var(--dsw-alias-bg-overlay,rgba(128,128,128,.12));',
      '  color:var(--dsw-alias-label-tertiary,#9aa0a6);}',
      '[data-x-msg][data-warn]{color:#f59e0b;}',
      '[data-x-msg][data-good]{color:#22c55e;}',
      '[data-x-msg][data-bad]{color:#ef4444;}',
      '[data-x-pre]{margin:6px 0 0;padding:8px 9px;border-radius:8px;max-height:260px;overflow:auto;font-size:11px;',
      '  line-height:15px;white-space:pre-wrap;overflow-wrap:anywhere;',
      '  background:var(--dsw-alias-bg-overlay,rgba(0,0,0,.25));color:var(--dsw-alias-label-secondary,#c9ccd1);}',
      '[data-x-kv]{font-size:11px;line-height:18px;color:var(--dsw-alias-label-tertiary,#9aa0a6);overflow-wrap:anywhere;}',
      '[data-x-badge]{font-size:11px;padding:2px 8px;border-radius:999px;white-space:nowrap;',
      '  background:var(--dsw-alias-bg-overlay,rgba(128,128,128,.14));color:var(--dsw-alias-label-secondary,#c9ccd1);}',
      '[data-x-badge][data-on]{background:rgba(59,130,246,.18);color:#60a5fa;}',
      '[data-x-badge][data-good]{background:rgba(34,197,94,.16);color:#4ade80;}',
      '[data-x-sub]{display:flex;flex-direction:column;gap:10px;margin-left:4px;padding-left:12px;',
      '  border-left:2px solid var(--dsw-alias-border-l2,rgba(128,128,128,.22));}',
      '[data-x-toast]{position:fixed;right:22px;bottom:22px;z-index:60;max-width:340px;',
      '  padding:9px 12px;border-radius:10px;font-size:12px;line-height:17px;',
      '  border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.16));',
      '  background:var(--dsw-alias-bg-overlay,#2a2d31);color:var(--dsw-alias-label-secondary,#c9ccd1);',
      '  box-shadow:0 8px 24px rgba(0,0,0,.35);overflow-wrap:anywhere;}',
      '[data-x-toast][data-good]{border-color:rgba(34,197,94,.5);color:#4ade80;}',
      '[data-x-toast][data-warn]{border-color:rgba(245,158,11,.5);color:#fbbf24;}',
      '[data-x-toast][data-bad]{border-color:rgba(239,68,68,.5);color:#f87171;}',
      '[data-x-sec][data-risk]{border-color:rgba(239,68,68,.45);',
      '  background:linear-gradient(0deg,rgba(239,68,68,.08),rgba(239,68,68,.08));',
      '  border-left:3px solid #ef4444;}',
    ].join('\n')

    function Switch({ on, onChange, disabled }) {
      return h('button', {
        'data-x-sw': '',
        'data-on': on ? '' : undefined,
        disabled: Boolean(disabled),
        title: on ? '已开' : '已关',
        onClick: () => { if (!disabled) onChange(!on) },
      }, h('i'))
    }

    function ToggleRow({ label, note, on, onChange, disabled }) {
      return h('div', { 'data-x-row': '' },
        h('div', { 'data-x-grow': '' },
          h('div', { 'data-x-label': '' }, label),
          note ? h('div', { 'data-x-note': '' }, note) : null),
        h(Switch, { on, onChange, disabled }))
    }

    function useStatus(intervalMs) {
      const [st, setSt] = React.useState(null)
      React.useEffect(() => {
        let alive = true
        const tick = async () => {
          try {
            const d = await jget('/status')
            if (alive && d?.ok) setSt(d)
          } catch { /* 网络抖一下就下次再问 */ }
        }
        tick()
        const t = setInterval(tick, intervalMs || 6000)
        return () => { alive = false; clearInterval(t) }
      }, [intervalMs])
      return [st, setSt]
    }

    function Panel() {
      const [st, setSt] = useStatus(6000)
      const [busy, setBusy] = React.useState('')
      const [msg, setMsg] = React.useState('')
      const [msgTone, setMsgTone] = React.useState('')

      // 输入框一律绑"本地草稿"：页面每 6 秒轮询 /status，直接绑 cfg 会把用户正在打的字冲掉
      const [dirs, setDirs] = React.useState(null)
      const [runAt, setRunAt] = React.useState(null)
      const [mirror, setMirror] = React.useState(null)
      const [ws, setWs] = React.useState(null)
      const [perDir, setPerDir] = React.useState(null)
      const [deepRead, setDeepRead] = React.useState(null)
      const [dshBin, setDshBin] = React.useState(null)
      const [twitterBin, setTwitterBin] = React.useState(null)
      const [proxy, setProxy] = React.useState(null)

      // 环境自检（原「扫码登录」区块）
      const [sc, setSc] = React.useState(null)
      const [scBusy, setScBusy] = React.useState(false)
      const [scNote, setScNote] = React.useState('')
      const [scTone, setScTone] = React.useState('')

      const [runNote, setRunNote] = React.useState(null)
      const [report, setReport] = React.useState(null)

      // 投递（会话 / 邮件 / 通知）
      const [sessionId, setSessionId] = React.useState(null)
      const [smtpHost, setSmtpHost] = React.useState(null)
      const [smtpPort, setSmtpPort] = React.useState(null)
      const [smtpUser, setSmtpUser] = React.useState(null)
      const [mailTo, setMailTo] = React.useState(null)
      const [smtpPass, setSmtpPass] = React.useState('')
      const [deliverMsg, setDeliverMsg] = React.useState('')
      const [deliverTone, setDeliverTone] = React.useState('')

      const alive = React.useRef(true)
      React.useEffect(() => () => { alive.current = false }, [])

      const cfg = st?.config
      React.useEffect(() => {
        if (!cfg) return
        if (dirs === null) setDirs(cfg.directions || '')
        if (runAt === null) setRunAt(cfg.runAt || '09:30')
        if (mirror === null) setMirror(cfg.mirrorDir || '')
        if (ws === null) setWs(cfg.workspace || '')
        if (perDir === null) setPerDir(String(cfg.perDirection ?? 20))
        if (deepRead === null) setDeepRead(String(cfg.deepRead ?? 8))
        if (dshBin === null) setDshBin(cfg.dshBin || '')
        if (twitterBin === null) setTwitterBin(cfg.twitterBin || '')
        if (proxy === null) setProxy(cfg.proxy || '')
        if (sessionId === null) setSessionId(cfg.sessionId || '')
        if (smtpHost === null) setSmtpHost(cfg.smtpHost || 'smtp.qq.com')
        if (smtpPort === null) setSmtpPort(String(cfg.smtpPort ?? 465))
        if (smtpUser === null) setSmtpUser(cfg.smtpUser || '')
        if (mailTo === null) setMailTo(cfg.mailTo || '')
      }, [cfg, dirs, runAt, mirror, ws, perDir, deepRead, dshBin, twitterBin, proxy, sessionId, smtpHost, smtpPort, smtpUser, mailTo])

      const flash = (text, tone) => { setMsg(text); setMsgTone(tone || '') }
      const patch = async (p, what) => {
        try {
          const d = await jpost('/config', { patch: p })
          if (d?.ok) { setSt(d); flash('已保存：' + what, 'good') } else flash('保存失败：' + (d?.error || '未知原因'), 'bad')
        } catch (e) { flash('保存失败：' + String(e?.message || e), 'bad') }
      }

      /**
       * ⭐ 自动保存：**改动即落盘**，不再依赖"记得点保存"。
       * 文本类 onBlur 立即存、输入类 350ms 防抖存；按钮保留当"兜底 + 心里踏实"。
       */
      const autoTimer = React.useRef(null)
      const pending = React.useRef({})
      const autoSave = (p, what) => {
        pending.current = { ...pending.current, ...p }
        if (autoTimer.current) clearTimeout(autoTimer.current)
        autoTimer.current = setTimeout(async () => {
          const body = pending.current
          pending.current = {}
          try {
            const d = await jpost('/config', { patch: body })
            if (!alive.current) return
            if (d?.ok) { setSt(d); flash('已自动保存 · ' + (what || Object.keys(body).join('/')), 'good') }
            else flash('保存失败：' + (d?.error || '未知原因'), 'bad')
          } catch (e) { flash('保存失败：' + String(e?.message || e), 'bad') }
        }, 350)
      }
      React.useEffect(() => () => { if (autoTimer.current) clearTimeout(autoTimer.current) }, [])

      /** 立刻把待保存的草稿刷盘（点按钮前必须调它，否则会读到旧配置） */
      const flushSave = async () => {
        if (!autoTimer.current) return
        clearTimeout(autoTimer.current)
        autoTimer.current = null
        const body = pending.current
        pending.current = {}
        if (!Object.keys(body).length) return
        try { const d = await jpost('/config', { patch: body }); if (d?.ok) setSt(d) } catch { /* 下面还会再报 */ }
      }

      // 反馈浮层 3 秒后自己消失，不占地方
      React.useEffect(() => {
        if (!msg) return
        const t = setTimeout(() => { if (alive.current) setMsg('') }, 3200)
        return () => clearTimeout(t)
      }, [msg, msgTone])

      /* 环境自检：进页面自动跑一次（MCP 要起 twitter-cli，慢一点是正常的） */
      const runSelfcheck = async (manual) => {
        if (manual) { setScBusy(true); setScNote('正在自检（起一次 MCP + twitter-cli，十几秒）…'); setScTone('') }
        try {
          const d = await jget('/selfcheck')
          if (!alive.current) return
          setSc(d)
          const okAccount = d?.account && !d.account.needLogin && d.account.handle
          if (d?.ok) { setScNote('能用：@' + d.account.handle + (d.account.followers ? ' · 粉丝 ' + d.account.followers : '')); setScTone('good') }
          else { setScNote('还不能用：' + (d?.error || (d?.proxy && !d.proxy.ok ? '代理不可用' : !d?.cred?.ok ? '凭据没读到' : okAccount ? '未登录' : '环境没就绪'))); setScTone('warn') }
        } catch (e) {
          if (alive.current) { setScNote('自检失败：' + String(e?.message || e)); setScTone('bad') }
        }
        if (manual) setScBusy(false)
      }
      React.useEffect(() => { runSelfcheck(false); /* eslint-disable-next-line */ }, [])

      const onRun = async () => {
        setBusy('run'); setRunNote(null)
        try {
          const d = await jpost('/run', { why: 'manual' })
          if (d?.started) setRunNote({ tone: 'good', text: '已经开跑（后台跑，大概 5-15 分钟），跑完日报会写到 ' + (d.report || '') })
          else setRunNote({ tone: 'warn', text: '没跑起来：' + (d?.error || '未知原因') })
          if (d?.ok) setSt(d)
        } catch (e) { setRunNote({ tone: 'warn', text: '没跑起来：' + String(e?.message || e) }) }
        setBusy('')
      }

      /** 解除风控冷却（只有使用者自己确认账号恢复后才该点） */
      const onClearRisk = async () => {
        setBusy('risk')
        try {
          const d = await jpost('/risk/clear', { note: '设置页手动解除（使用者确认账号已恢复）' })
          if (d?.ok) {
            flash('冷却已解除。建议先把量降下来（每方向 20 / 深读 8）再跑', 'good')
            try { setSt(await jget('/status')) } catch { /* 下次轮询会刷新 */ }
          } else flash('解除失败：' + (d?.error || ''), 'bad')
        } catch (e) { flash('解除失败：' + String(e?.message || e), 'bad') }
        setBusy('')
      }

      const onShowReport = async () => {
        setBusy('report')
        try {
          const d = await jget('/report')
          if (d?.exists) setReport(d.text)
          else { setReport(null); flash('今天还没有日报 —— 点「现在跑一轮」', 'warn') }
        } catch (e) { flash('读日报失败：' + String(e?.message || e), 'bad') }
        setBusy('')
      }

      const onOpen = async (what) => {
        try {
          const d = await jpost('/open', { what })
          if (!d?.ok) flash('打不开：' + (d?.error || ''), 'warn')
        } catch { /* 无所谓 */ }
      }

      const onSaveTexts = async () => {
        await patch({
          directions: String(dirs || ''),
          runAt: String(runAt || '09:30'),
          mirrorDir: String(mirror || '').trim(),
          workspace: String(ws || '').trim(),
          dshBin: String(dshBin || '').trim(),
          twitterBin: String(twitterBin || '').trim(),
          proxy: String(proxy || '').trim(),
          perDirection: Math.max(5, Math.min(Number(perDir) || 20, 50)),
          deepRead: Math.max(1, Math.min(Number(deepRead) || 8, 30)),
        }, '抓取 / 方向 / 目录')
      }

      /* ── 投递相关 ── */
      const dflash = (text, tone) => { setDeliverMsg(text); setDeliverTone(tone || '') }

      const onSaveDelivery = async () => {
        await patch({
          sessionId: String(sessionId || '').trim(),
          smtpHost: String(smtpHost || '').trim(),
          smtpPort: Math.max(1, Math.min(Number(smtpPort) || 465, 65535)),
          smtpUser: String(smtpUser || '').trim(),
          mailTo: String(mailTo || '').trim(),
        }, '投递设置')
        dflash('已保存', 'good')
      }

      const onSavePass = async () => {
        if (!String(smtpPass || '').trim()) { dflash('授权码是空的', 'warn'); return }
        await flushSave()
        try {
          const d = await jpost('/smtp-pass', { pass: String(smtpPass).trim() })
          if (d?.ok) { dflash(d.note || '授权码已保存', 'good'); setSmtpPass('') }
          else dflash('保存失败：' + (d?.error || ''), 'bad')
        } catch (e) { dflash('保存失败：' + String(e?.message || e), 'bad') }
      }

      const onClearPass = async () => {
        try {
          const d = await jpost('/smtp-pass/clear', {})
          if (d?.ok) dflash('授权码已清除', 'good')
          else dflash('清除失败：' + (d?.error || ''), 'bad')
        } catch (e) { dflash('清除失败：' + String(e?.message || e), 'bad') }
      }

      const onTest = async (what) => {
        setBusy('test:' + what)
        await flushSave()               // 先把刚改的账号/收件人存进去，否则测的是旧配置
        dflash(what === 'mail' ? '正在发测试邮件…' : what === 'session' ? '正在往会话里投一条…' : '正在弹通知…', '')
        try {
          const d = await jpost('/deliver/test', { what })
          const ch = d?.channels?.[what]
          if (ch?.ok) dflash(what === 'mail' ? '邮件发出去了（' + ((ch.accepted || []).join(',') || '已接受') + '）' : '成功', 'good')
          else dflash('失败：' + (ch?.why || d?.error || '未知原因'), 'warn')
        } catch (e) { dflash('失败：' + String(e?.message || e), 'bad') }
        setBusy('')
      }

      const onDeliverNow = async () => {
        setBusy('deliver')
        await flushSave()
        try {
          const d = await jpost('/deliver/now', { what: 'all' })
          const chs = d?.channels || {}
          const desc = Object.entries(chs).map(([k, v]) => k + '=' + (v?.ok ? 'ok' : '失败')).join(' · ')
          dflash(desc ? '已投递：' + desc : (d?.skipped || '没有通道开启'), d?.ok ? 'good' : 'warn')
          if (d?.ok) setSt(d)
        } catch (e) { dflash('失败：' + String(e?.message || e), 'bad') }
        setBusy('')
      }

      const PRESETS = {
        'smtp.qq.com': { port: 465, note: 'QQ 邮箱：设置 → 账户 → 开启 SMTP 服务，拿到「授权码」' },
        'smtp.163.com': { port: 465, note: '163 邮箱：设置 → POP3/SMTP → 开启，拿到「授权码」' },
        'smtp.gmail.com': { port: 465, note: 'Gmail：需要开启两步验证后生成「应用专用密码」' },
        'smtp-mail.outlook.com': { port: 587, note: 'Outlook：端口 587（STARTTLS）' },
      }
      const presetNote = PRESETS[String(smtpHost || '')]?.note || ''

      if (!st) return h('div', { 'data-x-page': '' }, h('div', { 'data-x-note': '' }, '读设置中…'))

      const sw = (k) => Boolean(cfg?.[k])
      const dirCount = String(dirs || '').split(/\r?\n/).filter((s) => s.trim()).length
      const envOk = Boolean(sc?.ok)

      return h('div', { 'data-x-page': '' },

        /* ── 顶部状态 ── */
        h('div', { 'data-x-row': '' },
          h('span', { 'data-x-badge': '', 'data-on': st.running ? '' : undefined }, st.running ? '正在跑' : (st.reportExists ? '今天已跑（' + st.pickedToday + ' 条）' : '今天还没跑')),
          h('span', { 'data-x-badge': '', 'data-good': envOk ? '' : undefined }, envOk ? '环境可用' : '环境待检'),
          h('span', { 'data-x-badge': '' }, '每天 ' + (cfg?.runAt || '09:30')),
          h('span', { 'data-x-badge': '' }, 'v' + (st.version || '?')),
          h('div', { 'data-x-grow': '' }),
          h('button', { 'data-x-btn': '', disabled: Boolean(busy) || st.running, onClick: onRun }, st.running ? '正在跑…' : '现在跑一轮')),
        runNote ? h('div', { 'data-x-msg': '', 'data-good': runNote.tone === 'good' ? '' : undefined, 'data-warn': runNote.tone === 'warn' ? '' : undefined }, runNote.text) : null,
        (st.lastRunAt ? h('div', { 'data-x-note': '' }, '上次跑：' + new Date(st.lastRunAt).toLocaleString('zh-CN')) : null),

        /* ── 风控冷却：撞了墙就别再撞 ── */
        st.risk?.inCooldown ? h('div', { 'data-x-sec': '', 'data-risk': '' },
          h('div', { 'data-x-row': '' },
            h('div', { 'data-x-grow': '' },
              h('div', { 'data-x-label': '', style: { color: '#f87171' } },
                '⛔ 风控冷却中 · 还剩 ' + (st.risk.cooldownLeftText || '')),
              h('div', { 'data-x-note': '' },
                (st.risk.reason ? '原因：' + st.risk.reason + '。' : '')
                + '冷却期内**连手动也不会跑**。撞到限流/风控之后继续跑，最容易把"提醒"升级成"封号"。')),
            h('button', { 'data-x-btn': '', disabled: Boolean(busy), onClick: onClearRisk }, '解除冷却')),
          st.risk.lastSignal ? h('div', { 'data-x-note': '' },
            '最后信号：' + st.risk.lastSignal.kind + ' · ' + String(st.risk.lastSignal.detail || '').slice(0, 80)) : null)
          : null,

        /* ── 什么时候跑 ── */
        h('div', { 'data-x-sec': '' },
          h('div', { 'data-x-h': '', 'data-dot': '⏰' }, '什么时候自己跑'),
          h(ToggleRow, {
            label: '每天自动刷一轮',
            note: '关掉之后只会手动跑；开着的话到点由 DSH 自己起一轮（不用你在场）',
            on: sw('enabled'),
            onChange: (v) => patch({ enabled: v }, '每天自动跑'),
          }),
          h('div', { 'data-x-row': '' },
            h('div', { 'data-x-grow': '' },
              h('div', { 'data-x-label': '' }, '每天几点'),
              h('div', { 'data-x-note': '' }, '到点那一分钟内 DSH 活着就会跑；错过的话下次打开 DSH 会补跑')),
            h('input', {
              'data-x-input': '', 'data-x-num': '', type: 'time', value: runAt || '09:30',
              onChange: (e) => { setRunAt(e.target.value); autoSave({ runAt: e.target.value }, '每天几点') },
            })),
          h(ToggleRow, {
            label: '错过也补跑',
            note: '那天 09:30 时电脑关着 / DSH 没开，下次打开时补上这一轮',
            on: sw('catchUp'),
            onChange: (v) => patch({ catchUp: v }, '错过补跑'),
          })),

        /* ── 关注什么 ── */
        h('div', { 'data-x-sec': '' },
          h('div', { 'data-x-h': '', 'data-dot': '🎯' }, '关注什么'),
          h('div', { 'data-x-label': '' }, '方向（一行一个，现在 ' + dirCount + ' 个）'),
          h('textarea', {
            'data-x-input': '', 'data-x-area': '', value: dirs || '',
            placeholder: 'AI / agent 与开源\n独立开发 / 出海收款\nA股工具与数据',
            onChange: (e) => { setDirs(e.target.value); autoSave({ directions: e.target.value }, '关注方向') },
            onBlur: (e) => autoSave({ directions: e.target.value }, '关注方向'),
          }),
          h('div', { 'data-x-note': '' }, '写"方向"而不是"关键词堆"：每个方向会被当成一次搜索词，也会决定它怎么归类热点。'),
          h('div', { 'data-x-row': '' },
            h('div', { 'data-x-grow': '' }, h('div', { 'data-x-label': '' }, '每个方向搜几条候选')),
            h('input', {
              'data-x-input': '', 'data-x-num': '', value: perDir || '',
              onChange: (e) => setPerDir(e.target.value.replace(/[^\d]/g, '')),
              onBlur: () => autoSave({ perDirection: Math.max(5, Math.min(Number(perDir) || 20, 50)) }, '每个方向搜几条'),
            })),
          h('div', { 'data-x-row': '' },
            h('div', { 'data-x-grow': '' }, h('div', { 'data-x-label': '' }, '全部方向一共深读几条（读全文）')),
            h('input', {
              'data-x-input': '', 'data-x-num': '', value: deepRead || '',
              onChange: (e) => setDeepRead(e.target.value.replace(/[^\d]/g, '')),
              onBlur: () => autoSave({ deepRead: Math.max(1, Math.min(Number(deepRead) || 8, 30)) }, '深读几条'),
            })),
          ((Number(perDir) || 0) > 25 || (Number(deepRead) || 0) > 12)
            ? h('div', { 'data-x-note': '', style: { color: '#fbbf24' } },
              '⚠️ 现在的量偏大（每方向 ' + (perDir || '?') + ' 条 × ' + dirCount + ' 个方向 = ' + ((Number(perDir) || 0) * dirCount) + ' 条候选，深读 ' + (deepRead || '?') + ' 条）。'
              + '建议值 20 / 8；量越大，越容易撞限流。')
            : null,
          h('div', { 'data-x-row': '' },
            h('div', { 'data-x-grow': '' }, h('div', { 'data-x-label': '' }, '排序')),
            h('select', {
              'data-x-input': '', value: cfg?.sort || 'general',
              onChange: (e) => patch({ sort: e.target.value }, '搜索排序'),
            },
            h('option', { value: 'general' }, '综合'),
            h('option', { value: 'latest' }, '最新'),
            h('option', { value: 'popular' }, '最热'))),
          h(ToggleRow, {
            label: '读回复区',
            note: '热点/争议的挑几条看回复 —— 回复区常比正文更能说明"大家在争什么"，也决定"回复区竞争小不小"',
            on: sw('readReplies'),
            onChange: (v) => patch({ readReplies: v }, '读回复区'),
          }),
          h('div', { 'data-x-row': '' },
            h('div', { 'data-x-grow': '' }, h('div', { 'data-x-label': '' }, '日报写多细')),
            h('select', {
              'data-x-input': '', value: cfg?.reportLevel || 'full',
              onChange: (e) => patch({ reportLevel: e.target.value }, '日报形态'),
            },
            h('option', { value: 'full' }, '完整（五节：一句话 + 热点 + 值得回 + 数据 + 风险）'),
            h('option', { value: 'brief' }, '薄版（一屏看完）'))),
          h('div', { 'data-x-label': '' }, '工作区镜像目录（写一份到这里，方便 git / 别的工具用；留空 = 不镜像）'),
          h('input', {
            'data-x-input': '', value: mirror || '',
            onChange: (e) => setMirror(e.target.value),
            onBlur: (e) => autoSave({ mirrorDir: String(e.target.value || '').trim() }, '工作区镜像目录'),
            placeholder: 'D:\\reports\\x-daily',
          }),
          h('div', { 'data-x-row': '' },
            h('button', { 'data-x-btn': '', disabled: Boolean(busy), onClick: onSaveTexts }, '再保存一次（其实已经自动存了）'))),

        /* ── 怎么把结果给你 ── */
        h('div', { 'data-x-sec': '' },
          h('div', { 'data-x-h': '', 'data-dot': '📮' }, '怎么把结果给你'),
          h('div', { 'data-x-note': '' }, '跑完一轮后自动投递；三个通道各自独立，可以只开一个。'),

          // ① 会话
          h('div', { 'data-x-row': '' },
            h('div', { 'data-x-grow': '' },
              h('div', { 'data-x-label': '' }, '投到 DSH 会话'),
              h('div', { 'data-x-note': '' }, '往聊天里推一条摘要，那个会话的 AI 会当场把要点说给你听')),
            h('select', {
              'data-x-input': '', value: cfg?.sessionTarget || 'off',
              onChange: (e) => patch({ sessionTarget: e.target.value }, '会话投递'),
            },
            h('option', { value: 'off' }, '不投'),
            h('option', { value: 'latest' }, '最近活跃的会话'),
            h('option', { value: 'fixed' }, '指定会话'))),
          (cfg?.sessionTarget === 'fixed')
            ? h('div', { 'data-x-row': '' },
              h('div', { 'data-x-grow': '' }, h('div', { 'data-x-note': '' }, '会话 ID（session-…）')),
              h('input', {
                'data-x-input': '', value: sessionId || '', placeholder: 'session-xxxxxxxx-...',
                onChange: (e) => setSessionId(e.target.value),
                onBlur: (e) => autoSave({ sessionId: String(e.target.value || '').trim() }, '日报会话 ID'),
              }))
            : null,
          h('div', { 'data-x-note': '' }, '💡 想固定投到某个会话：打开那个会话（比如新建一个「X 日报」），在里面说一句「把刷 X 的日报投到这个会话」—— AI 会调 x_bind_session 自动绑好，不用手抄 ID。'),
          cfg?.sessionTarget !== 'off' ? h('div', { 'data-x-note': '' }, '⚠️ 投进去的消息来源是「你」，所以那个会话会真的跑一轮模型（有成本）。') : null,
          cfg?.sessionTarget !== 'off' ? h(ToggleRow, {
            label: '投递时让 AI 讲两句',
            note: '只投摘要，让那个会话的 AI 用 3-5 句话把要点说出来（不塞全文）',
            on: sw('sessionSpeak'),
            onChange: (v) => patch({ sessionSpeak: v }, '会话里讲两句'),
          }) : null,

          // ② 邮件
          h(ToggleRow, {
            label: '发到邮箱',
            note: '摘要 + 完整日报（.md 附件）',
            on: sw('deliverMail'),
            onChange: (v) => patch({ deliverMail: v }, '邮件通知'),
          }),
          sw('deliverMail') ? h('div', { 'data-x-sub': '' },
            h('div', { 'data-x-wrap': '' },
              h('div', { 'data-x-label': '' }, 'SMTP 服务器'),
              h('input', {
                'data-x-input': '', value: smtpHost || '', placeholder: 'smtp.qq.com',
                onChange: (e) => setSmtpHost(e.target.value),
                onBlur: (e) => {
                  const host = String(e.target.value || '').trim()
                  const p = PRESETS[host]
                  if (p) { setSmtpPort(String(p.port)); autoSave({ smtpHost: host, smtpPort: p.port }, 'SMTP 服务器') } else autoSave({ smtpHost: host }, 'SMTP 服务器')
                },
              })),
            presetNote ? h('div', { 'data-x-note': '' }, presetNote) : null,
            h('div', { 'data-x-row': '' },
              h('div', { 'data-x-grow': '' }, h('div', { 'data-x-label': '' }, '端口')),
              h('input', {
                'data-x-input': '', 'data-x-num': '', value: smtpPort || '',
                onChange: (e) => setSmtpPort(e.target.value.replace(/[^\d]/g, '')),
                onBlur: () => autoSave({ smtpPort: Math.max(1, Math.min(Number(smtpPort) || 465, 65535)) }, 'SMTP 端口'),
              })),
            h('div', { 'data-x-wrap': '' },
              h('div', { 'data-x-label': '' }, '邮箱账号'),
              h('input', {
                'data-x-input': '', value: smtpUser || '', placeholder: 'you@qq.com',
                onChange: (e) => setSmtpUser(e.target.value),
                onBlur: (e) => autoSave({ smtpUser: String(e.target.value || '').trim() }, '邮箱账号'),
              })),
            h('div', { 'data-x-wrap': '' },
              h('div', { 'data-x-label': '' }, st.smtpPassConfigured ? '授权码（已配置；重填会覆盖）' : '授权码（不是登录密码）'),
              h('div', { 'data-x-row': '' },
                h('input', {
                  'data-x-input': '', type: 'password', value: smtpPass, placeholder: st.smtpPassConfigured ? '••••••••（已保存）' : '邮箱设置里开 SMTP 后拿到的授权码',
                  onChange: (e) => setSmtpPass(e.target.value),
                }),
                h('button', { 'data-x-btn': '', disabled: Boolean(busy), onClick: onSavePass }, '保存授权码'))),
            h('div', { 'data-x-note': '' }, '授权码交给 DSH 的 credentials 服务托管，不写进 config.json。'),
            st.smtpPassConfigured ? h('div', { 'data-x-row': '' }, h('button', { 'data-x-btn': '', onClick: onClearPass }, '清除授权码')) : null,
            h('div', { 'data-x-wrap': '' },
              h('div', { 'data-x-label': '' }, '发给谁（多个用逗号隔开）'),
              h('input', {
                'data-x-input': '', value: mailTo || '', placeholder: 'you@qq.com',
                onChange: (e) => setMailTo(e.target.value),
                onBlur: (e) => autoSave({ mailTo: String(e.target.value || '').trim() }, '收件人'),
              }))) : null,

          // ③ 桌面通知
          h(ToggleRow, {
            label: '弹 Windows 通知',
            note: '窗口没开、会话不可投时至少响一下（点不开文件，只是提醒）',
            on: sw('deliverToast'),
            onChange: (v) => patch({ deliverToast: v }, '桌面通知'),
          }),

          h('div', { 'data-x-row': '' },
            h('button', { 'data-x-btn': '', 'data-primary': '', disabled: Boolean(busy), onClick: onSaveDelivery }, '保存投递设置'),
            h('button', { 'data-x-btn': '', disabled: Boolean(busy), onClick: () => onTest('mail') }, '发测试邮件'),
            h('button', { 'data-x-btn': '', disabled: Boolean(busy), onClick: () => onTest('session') }, '测试会话投递'),
            h('button', { 'data-x-btn': '', disabled: Boolean(busy), onClick: onDeliverNow }, '把今天的日报发一遍')),
          deliverMsg ? h('div', { 'data-x-msg': '', 'data-good': deliverTone === 'good' ? '' : undefined, 'data-warn': deliverTone === 'warn' ? '' : undefined, 'data-bad': deliverTone === 'bad' ? '' : undefined }, deliverMsg) : null,
          st.lastDelivery ? h('div', { 'data-x-kv': '' },
            '上次投递：' + new Date(st.lastDelivery.at).toLocaleString('zh-CN') + ' · ' + (Object.entries(st.lastDelivery.channels || {}).map(([k, v]) => k + '=' + (v?.ok ? 'ok' : '失败')).join(' · ') || (st.lastDelivery.skipped || '无通道'))) : null),

        /* ── 环境与账号（原扫码登录区块）── */
        h('div', { 'data-x-sec': '' },
          h('div', { 'data-x-h': '', 'data-dot': '🔌' }, '环境自检'),
          h('div', { 'data-x-wrap': '' },
            h('div', { 'data-x-label': '' }, 'twitter 路径（留空自动找：X_TWITTER_BIN → PATH → 默认位置）'),
            h('input', {
              'data-x-input': '', value: twitterBin || '', placeholder: 'C:\\Users\\<你>\\.local\\bin\\twitter.exe',
              onChange: (e) => setTwitterBin(e.target.value),
              onBlur: (e) => autoSave({ twitterBin: String(e.target.value || '').trim() }, 'twitter 路径'),
            })),
          h('div', { 'data-x-wrap': '' },
            h('div', { 'data-x-label': '' }, '代理（留空自动探测：X_PROXY → 常见端口 → 系统代理）'),
            h('input', {
              'data-x-input': '', value: proxy || '', placeholder: 'http://127.0.0.1:7890',
              onChange: (e) => setProxy(e.target.value),
              onBlur: (e) => autoSave({ proxy: String(e.target.value || '').trim() }, '代理'),
            })),
          h('div', { 'data-x-row': '' },
            h('button', { 'data-x-btn': '', disabled: scBusy || Boolean(busy), onClick: () => runSelfcheck(true) }, scBusy ? '自检中…' : '重新自检'),
            h('div', { 'data-x-note': '' }, '凭据只从 HKCU 环境 / 进程环境读，只注入子进程，不显示也不落盘')),
          scNote ? h('div', { 'data-x-msg': '',
            'data-good': scTone === 'good' ? '' : undefined,
            'data-warn': scTone === 'warn' ? '' : undefined,
            'data-bad': scTone === 'bad' ? '' : undefined }, scNote) : null,
          sc ? h('div', { 'data-x-kv': '' },
            'twitter：' + (sc.cli?.version ? 'v' + sc.cli.version : '版本未知') + ' · ' + (sc.cli?.bin || '自动查找'),
            h('br'),
            '代理：' + (typeof sc.proxy?.ok === 'boolean' ? (sc.proxy.ok ? '可用' : '不可用') : (sc.ok ? '可用（账号已走通）' : '待验证')) + ' · ' + (sc.proxy?.url || '自动探测') + (sc.proxy?.source ? '（' + sc.proxy.source + '）' : ''),
            h('br'),
            '凭据：' + (sc.cred?.ok ? '已读到（只注入子进程，不显示内容）' : '没读到 TWITTER_AUTH_TOKEN / TWITTER_CT0'),
            h('br'),
            '账号：' + (sc.account?.needLogin
              ? '需要更新凭据'
              : ('@' + (sc.account?.handle || '') + (sc.account?.name ? '（' + sc.account.name + '）' : '')
                + ' · 粉丝 ' + (sc.account?.followers ?? 0) + ' · 推文 ' + (sc.account?.tweets ?? 0)
                + (sc.account?.verified ? ' · 蓝V' : '')))) : null,
          st.guide ? h('div', { 'data-x-note': '', style: { color: '#fbbf24' } },
            '上一次自动跑被门禁拦下（' + st.guide.stage + '）：' + String(st.guide.error || '').slice(0, 120)) : null),

        /* ── 高级 ── */
        h('div', { 'data-x-sec': '' },
          h('div', { 'data-x-h': '', 'data-dot': '⚙️' }, '高级'),
          h('div', { 'data-x-wrap': '' },
            h('div', { 'data-x-label': '' }, '工作区（按那儿的 AGENTS.md 说话；留空 = 中性说话）'),
            h('input', {
              'data-x-input': '', value: ws || '', placeholder: 'D:\\your-workspace',
              onChange: (e) => setWs(e.target.value),
              onBlur: (e) => autoSave({ workspace: String(e.target.value || '').trim() }, '工作区'),
            })),
          h('div', { 'data-x-wrap': '' },
            h('div', { 'data-x-label': '' }, 'dsh 路径（留空自动找）'),
            h('input', {
              'data-x-input': '', value: dshBin || '', placeholder: '…\\@deepseek-ai\\dsh\\lib\\bin.js',
              onChange: (e) => setDshBin(e.target.value),
              onBlur: (e) => autoSave({ dshBin: String(e.target.value || '').trim() }, 'dsh 路径'),
            })),
          h('div', { 'data-x-label': '' }, '跑一轮用哪个 profile'),
          h('input', { 'data-x-input': '', value: cfg?.headlessProfile || 'headless', disabled: true })),

        /* ── 它的地盘 ── */
        h('div', { 'data-x-sec': '' },
          h('div', { 'data-x-h': '', 'data-dot': '📁' }, '它的地盘'),
          h('div', { 'data-x-kv': '' },
            '家目录：' + (st.home || ''),
            h('br'),
            '今日日报：' + (st.report || ''),
            st.mirror ? h('br') : null,
            st.mirror ? '工作区镜像：' + st.mirror : null),
          h('div', { 'data-x-row': '' },
            h('button', { 'data-x-btn': '', disabled: busy === 'report', onClick: onShowReport }, '看今日日报'),
            h('button', { 'data-x-btn': '', onClick: () => onOpen('out') }, '打开报告文件夹'),
            h('button', { 'data-x-btn': '', onClick: () => onOpen('home') }, '打开家目录'),
            h('button', { 'data-x-btn': '', onClick: () => { if (st.report) { try { navigator.clipboard?.writeText(st.report) } catch { /* 无所谓 */ } } } }, '复制路径')),
          report !== null ? h('pre', { 'data-x-pre': '' }, report) : null),

        /* 保存反馈浮层（右下角，3 秒后自己消失） */
        msg ? h('div', {
          'data-x-toast': '',
          'data-good': msgTone === 'good' ? '' : undefined,
          'data-warn': msgTone === 'warn' ? '' : undefined,
          'data-bad': msgTone === 'bad' ? '' : undefined,
        }, msg) : null,
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const style = document.createElement('style')
        style.setAttribute('data-plugin-css', 'dsh-x-scroll')
        style.textContent = CSS
        document.head.appendChild(style)
        ctx.effect(() => () => style.remove(), 'dsh-x-scroll: 设置页样式')

        const slots = (typeof ctx.get === 'function' ? ctx.get('slots') : undefined) || ctx.slots
        if (!slots) return
        slots.inject('settings.section', () => slots.register(
          { name: 'settings.section', id: 'x-scroll', order: 31, label: '刷 X' },
          () => h(Panel),
        ))
      },
    }
  },
})