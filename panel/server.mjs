import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------- 运行环境 ----------------
// MIGPT_MODE 决定用哪种方式管理引擎进程：
//   systemd → 宿主机部署，走 systemctl / journalctl（老方式，默认）
//   local   → 容器内没有 systemd，改为「入口脚本守护循环 + 日志文件」
// 两种模式对外接口一致，面板界面代码完全不用改。
const MODE = process.env.MIGPT_MODE === 'local' ? 'local' : 'systemd';
const UNIT = process.env.MIGPT_UNIT || 'migpt-next';
const PORT = Number(process.env.MIGPT_PORT || 36593);

const NEXT_DIR = process.env.MIGPT_ENGINE_DIR || '/root/migpt-next-2';
// 配置文件的真实位置。宿主机上就在引擎目录里；容器里在挂载卷 /data 上，
// 由入口脚本通过 MIGPT_EDITABLE 指过来 —— 面板不能想当然地认为它和代码同目录。
const EDITABLE_PATH = process.env.MIGPT_EDITABLE || path.join(NEXT_DIR, 'editable.json');
// 备份跟着配置文件走，免得两边分家
const BAK_DIR = process.env.MIGPT_BACKUP_DIR || path.join(path.dirname(EDITABLE_PATH), 'backups');
const TTS_API = process.env.MIGPT_TTS_API || 'http://127.0.0.1:36594';
// 面板等 TTS 结果的最长时间。MiMo 复刻正常 3~12 秒，但实测会偶发飙到 70 秒以上；
// 这里原来是 40/30 秒，超了就会给用户报一个「生成失败」的假警报。
const TTS_CLIENT_TIMEOUT = Number(process.env.MIGPT_TTS_TIMEOUT || 150) * 1000;

// 面板自己的运行时数据（cmd.json / chat-mode / tts / 日志）。
// 宿主机上默认就在本文件旁边（老行为不变）；容器里由镜像设 MIGPT_PANEL_DIR=/data，
// 这样所有会变化的东西都落在挂载卷上，代码目录保持只读。
// 注意：不能靠软链接做持久化 —— 面板关闭连续对话时会 unlink 掉软链接本身，
// 下一次写入就变成容器内的真文件，持久化悄悄失效。
const DATA_DIR = process.env.MIGPT_PANEL_DIR || __dirname;
fs.mkdirSync(DATA_DIR, { recursive: true });
const SAFE_FILE = path.join(DATA_DIR, 'no-restart');
const CHAT_MODE_FILE = path.join(DATA_DIR, 'chat-mode');   // 连续聊天模式开关文件
const TTS_DIR = path.join(DATA_DIR, 'tts');
const CMD_FILE = path.join(DATA_DIR, 'cmd.json');
// local 模式专用：守护进程写这里，面板只读
const LOG_FILE = process.env.MIGPT_LOG_FILE || path.join(DATA_DIR, 'engine.log');
const RUN_DIR = process.env.MIGPT_RUN_DIR || path.join(DATA_DIR, 'control');
const REQ_FILE = path.join(RUN_DIR, 'request');   // 内容：restart / stop / start
const PID_FILE = path.join(RUN_DIR, 'engine.pid');

const HTML = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');

async function run(cmd, args, timeout = 40000) {
  try {
    const { stdout } = await execFileAsync(cmd, args, { timeout, maxBuffer: 8 * 1024 * 1024 });
    return stdout || '';
  } catch (e) {
    return (e && e.stdout ? e.stdout : '') + (e && e.stderr ? e.stderr : '');
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------- 进程控制（双后端）----------------
async function svcRequest(action) {
  if (MODE === 'systemd') return run('systemctl', [action, UNIT]);
  // local：不能由面板自己杀进程（面板和引擎是兄弟进程，杀了没人拉起来），
  // 改为写请求文件，交给 entrypoint 的守护循环执行。
  try {
    fs.mkdirSync(RUN_DIR, { recursive: true });
    fs.writeFileSync(REQ_FILE, action);
    return '已请求 ' + action + '（容器模式由守护进程执行）';
  } catch (e) {
    return '请求失败: ' + (e && e.message);
  }
}

function localPidAlive() {
  try {
    const pid = Number(fs.readFileSync(PID_FILE, 'utf8').trim());
    if (!pid) return 0;
    process.kill(pid, 0);   // 存在则返回，不存在抛错
    return pid;
  } catch { return 0; }
}

async function getStatus() {
  if (MODE === 'systemd') {
    const [active, pid, since] = await Promise.all([
      run('systemctl', ['is-active', UNIT]),
      run('systemctl', ['show', UNIT, '-p', 'MainPID', '--value']),
      run('systemctl', ['show', UNIT, '-p', 'ActiveEnterTimestamp', '--value']),
    ]);
    return { active: active.trim(), pid: pid.trim(), since: since.trim() };
  }
  const pid = localPidAlive();
  let since = '';
  try { since = fs.statSync(LOG_FILE).mtime.toISOString(); } catch {}
  return { active: pid ? 'active' : 'inactive', pid: pid ? String(pid) : '', since };
}

// ---------------- 日志读取（双后端，统一输出 {t, msg}）----------------
async function readLogRecords(n) {
  if (MODE === 'local') {
    let txt = '';
    try { txt = fs.readFileSync(LOG_FILE, 'utf8'); } catch { return []; }
    return txt.split('\n').filter((l) => l.trim()).slice(-n).map((line) => {
      // entrypoint 每行前缀 ISO 时间戳：2026-10-06T11:20:33+08:00 消息内容
      const m = line.match(/^(\d{4}-\d{2}-\d{2}T[\d:+.]+)\s+([\s\S]*)$/);
      const t = m ? Math.floor(new Date(m[1]).getTime() / 1000) : Math.floor(Date.now() / 1000);
      return { t, msg: (m ? m[2] : line).trim() };
    });
  }
  const out = await run('journalctl', ['-u', UNIT, '-n', String(n), '--no-pager', '-o', 'json']);
  const recs = [];
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    let j;
    try { j = JSON.parse(line); } catch { continue; }
    let msg = j.MESSAGE;
    if (Array.isArray(msg)) msg = msg.join('');
    if (typeof msg !== 'string') continue;
    recs.push({ t: Math.floor(Number(j.__REALTIME_TIMESTAMP || 0) / 1000), msg });
  }
  return recs;
}

async function getChat() {
  const items = [];
  for (const { t, msg } of await readLogRecords(800)) {
    const m = msg.match(/^(🔥|🔊|🔈|🤖|⚠️|❌)\s*(.+)$/);
    if (m) { items.push({ t, icon: m[1], text: m[2].trim() }); continue; }
    if (/服务已启动|MiGPT-Next v/.test(msg)) items.push({ t, icon: '✅', text: msg.trim().slice(0, 60) });
  }
  return items.slice(-80);
}

async function healthCheck() {
  const lines = (await readLogRecords(30)).map((r) => r.msg).filter(Boolean);
  const started = lines.some((l) => /服务已启动/.test(l));
  const errs = lines.filter((l) => /❌|登录失败|初始化.*失败|Error:|错误/.test(l)).slice(-3);
  return { started, errors: errs };
}

const readEditable = () => JSON.parse(fs.readFileSync(EDITABLE_PATH, 'utf8'));

// ---------------- 校验 ----------------
function validate(e) {
  const bad = (m) => { throw new Error(m); };
  const num = (v, min, max, name) => {
    const n = Number(v);
    if (!Number.isFinite(n) || n < min || n > max) bad(`${name} 需要是 ${min}~${max} 的数字`);
    return n;
  };
  const str = (v, name, min, max, re) => {
    if (typeof v !== 'string') bad(`${name} 格式不对`);
    const t = v.trim();
    if (t.length < min) bad(`${name} 不能为空`);
    if (t.length > max) bad(`${name} 最多 ${max} 字`);
    if (re && !re.test(t)) bad(`${name} 格式不正确`);
    return t;
  };

  if (!Array.isArray(e.callAIKeywords) || !e.callAIKeywords.length) bad('触发词不能为空');
  if (e.callAIKeywords.length > 30) bad('触发词最多 30 个');
  if (e.callAIKeywords.some((k) => typeof k !== 'string' || /[\n\r]/.test(k))) bad('触发词格式不对');

  const placeholder = typeof e.placeholder === 'string' ? e.placeholder : '';
  if (placeholder.length > 30) bad('占位语最多 30 字');

  let tts = e.ttsAction;
  if (tts && !Array.isArray(tts) && typeof tts === 'object') {
    // 兜底：前端可能把数组序列化成 {0:5,1:1}
    tts = Object.keys(tts).sort((a, b) => Number(a) - Number(b)).map((k) => tts[k]);
  }
  if (!Array.isArray(tts)) tts = [];
  if (tts.length !== 2) bad('TTS 动作需要两个数字（siid / aiid）');

  // 唤醒指令（原版 MiGPT 的 wakeUpCommand，用于连续对话补唤醒）
  let wake = e.wakeUpAction;
  if (wake && !Array.isArray(wake) && typeof wake === 'object') {
    wake = Object.keys(wake).sort((a, b) => Number(a) - Number(b)).map((k) => wake[k]);
  }
  if (!Array.isArray(wake)) wake = [];
  if (wake.length !== 2) bad('唤醒动作需要两个数字（siid / aiid）');

  // 留空让用户自己填：必须是他本机局域网地址，写死任何人的地址都是错的。
  // 没填时 config.js 会在播报时打印明确警告。
  const ttsBase = str((e.tts && e.tts.baseUrl) || process.env.MIGPT_PUBLIC_BASE || '', 'TTS 音频地址前缀', 0, 200);
  if (!/^https?:\/\//.test(ttsBase)) bad('TTS 音频地址前缀必须以 http:// 或 https:// 开头');

  const baseURL = str(e.openai && e.openai.baseURL, 'API 地址', 8, 300);
  if (!/^https?:\/\//.test(baseURL)) bad('API 地址必须以 http:// 或 https:// 开头');

  return {
    callAIKeywords: e.callAIKeywords.map((k) => k.trim()),
    kwMatch: e.kwMatch === 'start' ? 'start' : 'contain',
    persona: str(e.persona, '人设', 1, 4000),
    placeholder,
    keepNativeAnswer: !!e.keepNativeAnswer,
    reStopBeforeReply: e.reStopBeforeReply !== false,
    debug: !!e.debug,
    historyMaxLength: num(e.historyMaxLength, 0, 50, '历史对话条数'),
    maxReplyLength: num(e.maxReplyLength, 0, 2000, '最大回复长度'),
    ttsAction: [num(tts[0], 0, 99, 'TTS siid'), num(tts[1], 0, 99, 'TTS aiid')],
    wakeUpAction: [num(wake[0], 0, 99, '唤醒 siid'), num(wake[1], 0, 99, '唤醒 aiid')],
    tts: {
      enabled: !!(e.tts && e.tts.enabled),
      engine: ['clone', 'mimo', 'edge'].includes(e.tts && e.tts.engine) ? e.tts.engine : 'clone',
      // ── 微软 edge-tts 专用（免费引擎）──
      voice: str((e.tts && e.tts.voice) || 'zh-CN-XiaoxiaoNeural', '微软音色', 3, 80, /^[A-Za-z0-9-]+$/),
      rate: (() => { const v = String((e.tts && e.tts.rate) ?? '+0%').trim(); return /^[+-]\d{1,3}%$/.test(v) ? v : '+0%'; })(),
      pitch: (() => { const v = String((e.tts && e.tts.pitch) ?? '+0Hz').trim(); return /^[+-]\d{1,3}Hz$/.test(v) ? v : '+0Hz'; })(),
      volume: (() => { const v = String((e.tts && e.tts.volume) ?? '+0%').trim(); return /^[+-]\d{1,3}%$/.test(v) ? v : '+0%'; })(),
      mimoApiKey: (e.tts && e.tts.mimoApiKey) || '',
      mimoModel: str((e.tts && e.tts.mimoModel) || 'mimo-v2.5-tts-voicedesign', 'MiMo 模型', 4, 60),
      mimoStyle: (e.tts && e.tts.mimoStyle) || '',
      cloneRef: str((e.tts && e.tts.cloneRef) || '/root/tts-samples/ref7.mp3', '参考音频路径', 4, 300),
      cloneFallbackStyle: (e.tts && e.tts.cloneFallbackStyle) || '',
      cloneFallbackModel: (e.tts && e.tts.cloneFallbackModel) || 'mimo-v2.5-tts-voicedesign',
      cloneTimeout: (() => { const v = Number((e.tts && e.tts.cloneTimeout) ?? 15); return Number.isFinite(v) && v >= 2 && v <= 120 ? v : 15; })(),
      speed: (() => { const v = Number((e.tts && e.tts.speed) ?? 1); return Number.isFinite(v) && v >= 0.5 && v <= 4 ? v : 1; })(),
      baseUrl: ttsBase,
      fallbackToBuiltin: !(e.tts && e.tts.fallbackToBuiltin === false),
    },
    speaker: {
      did: str(e.speaker && e.speaker.did, '设备 did', 1, 32, /^\d+$/),
      userId: str(e.speaker && e.speaker.userId, '账号 userId', 1, 32, /^\d+$/),
      passToken: str(e.speaker && e.speaker.passToken, 'passToken', 20, 2000),
      heartbeat: num(e.speaker && e.speaker.heartbeat, 200, 5000, '轮询间隔'),
    },
    openai: {
      baseURL,
      apiKey: str(e.openai && e.openai.apiKey, 'API Key', 8, 500),
      model: str(e.openai && e.openai.model, '模型名', 1, 120),
      disableThinking: !!(e.openai && e.openai.disableThinking),
      enableProxy: !!(e.openai && e.openai.enableProxy),
      timeout: num(e.openai && e.openai.timeout, 1000, 300000, '请求超时'),
    },
  };
}

function deepMerge(base, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return patch === undefined ? base : patch;
  const out = { ...(base && typeof base === 'object' && !Array.isArray(base) ? base : {}) };
  for (const [k, v] of Object.entries(patch)) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) ? deepMerge(out[k], v) : v;
  }
  return out;
}

function saveEditable(next) {
  // 与现有配置合并：页面只提交部分字段时，其余字段保持原值，绝不会被清空
  const clean = validate(deepMerge(readEditable(), next || {}));
  const json = JSON.stringify(clean, null, 2);
  JSON.parse(json);
  fs.mkdirSync(BAK_DIR, { recursive: true });
  if (fs.existsSync(EDITABLE_PATH)) {
    fs.copyFileSync(EDITABLE_PATH, EDITABLE_PATH + '.bak');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    fs.copyFileSync(EDITABLE_PATH, path.join(BAK_DIR, `editable-${stamp}.json`));
    // 只保留最近 20 份
    const olds = fs.readdirSync(BAK_DIR).filter((f) => f.startsWith('editable-')).sort();
    while (olds.length > 20) fs.unlinkSync(path.join(BAK_DIR, olds.shift()));
  }
  fs.writeFileSync(EDITABLE_PATH + '.tmp', json, 'utf8');
  fs.renameSync(EDITABLE_PATH + '.tmp', EDITABLE_PATH);
  return clean;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let d = '';
    req.on('data', (c) => { d += c; if (d.length > 400000) { reject(new Error('请求体过大')); req.destroy(); } });
    req.on('end', () => resolve(d));
    req.on('error', reject);
  });
}

// ---------------- HTTP ----------------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const send = (code, body, type) => {
    res.writeHead(code, { 'Content-Type': type || 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(body);
  };
  try {
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0', 'Pragma': 'no-cache', 'Expires': '0' });
      return res.end(HTML);
    }
    // 托管 TTS 生成的音频，供音箱拉取
    if (req.method === 'GET' && url.pathname.startsWith('/tts/')) {
      const f = path.join(TTS_DIR, path.basename(decodeURIComponent(url.pathname)));
      if (!fs.existsSync(f)) return send(404, 'not found', 'text/plain');
      const buf = fs.readFileSync(f);
      res.writeHead(200, {
        'Content-Type': 'audio/mpeg',
        'Content-Length': buf.length,
        'Cache-Control': 'no-store',
        'Accept-Ranges': 'bytes',
      });
      return res.end(buf);
    }

    if (req.method === 'GET' && url.pathname === '/api/state') {
      const [status, chat] = await Promise.all([getStatus(), getChat()]);
      return send(200, JSON.stringify({ status, chat, editable: readEditable(), safeMode: fs.existsSync(SAFE_FILE), chatMode: fs.existsSync(CHAT_MODE_FILE), now: Date.now() }));
    }

    if (req.method === 'POST' && url.pathname === '/api/tts/speaker') {
      let b;
      try { b = JSON.parse((await readBody(req)) || '{}'); } catch { return send(400, JSON.stringify({ ok: false, error: '请求格式错误' })); }
      const voice = String(b.voice || '').trim();
      const text = String(b.text || '').trim();
      if (!text) return send(400, JSON.stringify({ ok: false, error: '缺少试听文本' }));
      const name = 'preview-' + Date.now() + '.mp3';
      let gen;
      try {
        const r = await fetch(TTS_API + '/say?text=' + encodeURIComponent(text) +
          '&engine=' + encodeURIComponent(b.engine || '') +
          '&style=' + encodeURIComponent(b.style || '') +
          '&model=' + encodeURIComponent(b.model || '') +
          '&voice=' + encodeURIComponent(voice) +
          '&rate=' + encodeURIComponent(b.rate || '') +
          '&pitch=' + encodeURIComponent(b.pitch || '') +
          '&volume=' + encodeURIComponent(b.volume || '') +
          '&name=' + encodeURIComponent(name),
          // MiMo 复刻正常 3~12 秒，但实测会偶发飙到 70 秒以上，别掐太早造成假失败
          { signal: AbortSignal.timeout(TTS_CLIENT_TIMEOUT) });
        gen = await r.json();
      } catch (e) { return send(502, JSON.stringify({ ok: false, error: 'TTS 服务不可用: ' + String(e && e.message) })); }
      if (!gen.ok) return send(400, JSON.stringify({ ok: false, error: gen.error || '生成失败' }));
      const t0 = readEditable().tts || {};
      // 兜底用当前浏览器的访问地址：面板从哪访问的，音箱多半也能从那个地址拿到音频
      const base = String(t0.baseUrl || ('http://' + (req.headers.host || '127.0.0.1:36593'))).replace(/\/+$/, '');
      fs.writeFileSync(CMD_FILE, JSON.stringify({ ts: Date.now(), url: base + '/tts/' + name }));
      return send(200, JSON.stringify({ ok: true, ms: gen.ms, queued: true, url: base + '/tts/' + name }));
    }

    if (req.method === 'POST' && url.pathname === '/api/tts/test') {
      let body;
      try { body = JSON.parse((await readBody(req)) || '{}'); }
      catch { return send(400, JSON.stringify({ ok: false, error: '请求格式错误' })); }
      const voice = String(body.voice || '').trim();
      const text = String(body.text || '').trim();
      if (!text) return send(400, JSON.stringify({ ok: false, error: '缺少试听文本' }));
      const name = 'preview-' + Date.now() + '.mp3';
      let gen;
      try {
        const r = await fetch(TTS_API + '/say?text=' + encodeURIComponent(text) +
          '&engine=' + encodeURIComponent(body.engine || '') +
          '&style=' + encodeURIComponent(body.style || '') +
          '&model=' + encodeURIComponent(body.model || '') +
          '&voice=' + encodeURIComponent(voice) +
          '&rate=' + encodeURIComponent(body.rate || '+0%') +
          '&pitch=' + encodeURIComponent(body.pitch || '+0Hz') +
          '&volume=' + encodeURIComponent(body.volume || '+0%') +
          '&name=' + encodeURIComponent(name),
          { signal: AbortSignal.timeout(TTS_CLIENT_TIMEOUT) });
        gen = await r.json();
      } catch (e) {
        return send(502, JSON.stringify({ ok: false, error: 'TTS 服务不可用: ' + String(e && e.message) }));
      }
      if (!gen.ok) return send(400, JSON.stringify({ ok: false, error: gen.error || '生成失败' }));
      const t0 = readEditable().tts || {};
      // 兜底用当前浏览器的访问地址：面板从哪访问的，音箱多半也能从那个地址拿到音频
      const base = String(t0.baseUrl || ('http://' + (req.headers.host || '127.0.0.1:36593'))).replace(/\/+$/, '');
      return send(200, JSON.stringify({ ok: true, ms: gen.ms, size: gen.size, engine: gen.engine, url: base + '/tts/' + name }));
    }

    if (req.method === 'GET' && url.pathname === '/api/mode') {
      return send(200, JSON.stringify({ ok: true, on: fs.existsSync(CHAT_MODE_FILE) }));
    }
    if (req.method === 'POST' && url.pathname === '/api/mode') {
      let b;
      try { b = JSON.parse((await readBody(req)) || '{}'); } catch { return send(400, JSON.stringify({ ok: false, error: '请求格式错误' })); }
      try {
        if (b.on) fs.writeFileSync(CHAT_MODE_FILE, String(Date.now()));
        else if (fs.existsSync(CHAT_MODE_FILE)) fs.unlinkSync(CHAT_MODE_FILE);
        return send(200, JSON.stringify({ ok: true, on: fs.existsSync(CHAT_MODE_FILE) }));
      } catch (e) { return send(500, JSON.stringify({ ok: false, error: e.message })); }
    }
    // 手动补唤醒：让音箱立刻回到"听"的状态（原版 MiGPT 的 wakeUp 指令）
    if (req.method === 'POST' && url.pathname === '/api/wakeup') {
      try {
        fs.writeFileSync(CMD_FILE, JSON.stringify({ ts: Date.now(), action: 'wakeup' }));
        return send(200, JSON.stringify({ ok: true }));
      } catch (e) { return send(500, JSON.stringify({ ok: false, error: e.message })); }
    }
    if (req.method === 'POST' && url.pathname === '/api/config') {
      console.log('📥 收到配置保存请求');
      let saved;
      try {
        saved = saveEditable(JSON.parse((await readBody(req)) || '{}'));
      } catch (e) {
        console.log('❌ 保存被拒: ' + String(e && e.message));
        return send(400, JSON.stringify({ ok: false, error: String(e && e.message) }));
      }
      const allowRestart = !fs.existsSync(SAFE_FILE);
      if (allowRestart) { await svcRequest('restart'); }
      else { console.log('🛡️ 安全模式：已跳过重启'); }
      await sleep(allowRestart ? 6000 : 400);
      const active = (await getStatus()).active;
      const health = await healthCheck();
      const healthy = active === 'active' && health.started && !health.errors.length;
      return send(200, JSON.stringify({
        ok: healthy,
        active,
        started: health.started,
        errors: health.errors,
        kwCount: saved.callAIKeywords.length,
        error: healthy ? undefined
          : (active !== 'active' ? '服务重启后未运行 —— 建议点「回滚到上一次」'
            : (!health.started ? '服务在运行但未打印启动成功，可能登录失败'
              : '启动日志里有报错：' + health.errors.join(' | '))),
      }));
    }

    if (req.method === 'POST' && url.pathname === '/api/config/rollback') {
      if (!fs.existsSync(EDITABLE_PATH + '.bak')) {
        return send(400, JSON.stringify({ ok: false, error: '还没有可回滚的备份（需要先保存过一次）' }));
      }
      fs.copyFileSync(EDITABLE_PATH + '.bak', EDITABLE_PATH);
      const allowRestart = !fs.existsSync(SAFE_FILE);
      if (allowRestart) { await svcRequest('restart'); }
      else { console.log('🛡️ 安全模式：已跳过重启'); }
      await sleep(allowRestart ? 6000 : 400);
      const health = await healthCheck();
      return send(200, JSON.stringify({
        ok: true,
        restoredKw: readEditable().callAIKeywords.length,
        started: health.started,
      }));
    }

    if (req.method === 'POST' && url.pathname.startsWith('/api/')) {
      const action = url.pathname.slice(5);
      let out = '';
      if (action === 'restart') out = fs.existsSync(SAFE_FILE) ? '🛡️ 安全模式：已忽略重启请求' : await svcRequest('restart');
      else if (action === 'stop') out = await svcRequest('stop');
      else if (action === 'start') out = await svcRequest('start');
      else if (action === 'silence') out = await run('node', [path.join(__dirname, 'silence.mjs')], 60000);
      else if (action === 'reset') {
        if (fs.existsSync(EDITABLE_PATH + '.v1.bak')) {
          fs.copyFileSync(EDITABLE_PATH + '.v1.bak', EDITABLE_PATH);
          if (!fs.existsSync(SAFE_FILE)) await svcRequest('restart');
          await sleep(5000);
        }
        out = '已恢复到重构前的配置';
      }
      else return send(404, JSON.stringify({ ok: false, error: 'unknown action' }));
      return send(200, JSON.stringify({ ok: true, out: String(out).trim().slice(0, 400) }));
    }
    return send(404, JSON.stringify({ ok: false, error: 'not found' }));
  } catch (e) {
    return send(500, JSON.stringify({ ok: false, error: String(e && e.message) }));
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`🐱 MiGPT-X 控制台已启动，端口 ${PORT}（进程模式: ${MODE}${MODE === 'systemd' ? ' / ' + UNIT : ''}）`);
});
