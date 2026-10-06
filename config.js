import fs from 'node:fs';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 📁 路径约定
// 宿主机部署时全部走默认值，行为和以前一字不差；
// 容器部署时由镜像设 MIGPT_DATA_DIR=/data、MIGPT_PANEL_DIR=/data，
// 让所有会变化的东西（配置、登录缓存、音频、开关文件）都落在挂载卷上，
// 代码目录保持只读、可随时重建。
const DATA_DIR = process.env.MIGPT_DATA_DIR || __dirname;      // editable.json / .mi.json
const PANEL_DIR = process.env.MIGPT_PANEL_DIR || '/root/migpt-panel';   // 面板的运行时数据

// ⚙️ 所有可配置项都在 editable.json 里，可从 Web 面板在线编辑
const E = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'editable.json'), 'utf8'));

const TTS_ACTION = E.ttsAction ?? [5, 1];
const TTS_DIR = process.env.MIGPT_TTS_DIR || path.join(PANEL_DIR, 'tts');
const EDGE_TTS = process.env.MIGPT_EDGE_TTS || '/root/tts-venv/bin/edge-tts';

// 💬 连续聊天模式：文件存在 = 已开启。
// 用文件而不是内存变量，是为了能随时切换、不需要重启引擎。
const CHAT_MODE_FILE = process.env.MIGPT_CHAT_MODE_FILE || path.join(PANEL_DIR, 'chat-mode');

// 👂 连续对话（原版 MiGPT 的 keepAlive / 唤醒模式机制）
// 原版每次回答结束会补发一条 MIoT 指令让音箱重新进入"听"的状态，
// 这样后续说话就不用再喊"小爱同学"。原版用流式响应判断播完，
// 这里没有流式回调，改用 ffprobe 算音频时长来等它播完。
const WAKE_UP_ACTION = Array.isArray(E.wakeUpAction) ? E.wakeUpAction : [5, 3];
const K_ARE_YOU_OK = '\u00bf\u029e\u043e \u2229\u043e\u028e \u01dd\u0279\u0250'; // 音箱念不出的乱码 → 静默（原版同款）
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function durMs(file) {
  try {
    const out = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { timeout: 8000 }).toString().trim();
    const d = parseFloat(out);
    return Number.isFinite(d) && d > 0 ? Math.round(d * 1000) : 0;
  } catch {
    return 0;
  }
}

// 引擎要等 MiService.init() 跑完，engine.MiOT / engine.MiNA 才存在。
// 面板按钮可能在启动后 1 秒内就被点到，那时点会抛 "reading 'doAction'"，
// 所以这里先等它就绪；等不到就友好提示，不再抛原始 TypeError。
async function waitEngineReady(engine, seconds) {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    if (engine && engine.MiOT && engine.MiNA) return true;
    await sleep(300);
  }
  return false;
}

async function wakeUp(engine, opts) {
  opts = opts || {};
  try {
    if (!engine || !engine.MiOT) {
      if (opts.retry) {
        console.log('⏳ 引擎正在登录小米服务，等它就绪…');
        if (!(await waitEngineReady(engine, opts.retry))) {
          console.warn('⚠️ 引擎 ' + opts.retry + ' 秒内仍未就绪，本次唤醒已跳过（刚重启时点太快了）');
          return false;
        }
      } else {
        console.warn('⚠️ 引擎还没登录完成，稍等几秒再试');
        return false;
      }
    }
    const action = WAKE_UP_ACTION;
    const ok = await engine.MiOT.doAction(action[0], action[1]);
    console.log(ok ? '👂 已补唤醒指令，现在可直接说话（不用喊小爱同学）' : '⚠️ 唤醒指令返回失败');
    return ok;
  } catch (e) {
    console.warn('⚠️ 唤醒指令异常: ' + (e && e.message));
    return false;
  }
}

async function unWakeUp(engine) {
  try {
    if (!engine || !engine.MiOT) return;
    await engine.speaker.pause();
    await sleep(120);
    await engine.MiOT.doAction(TTS_ACTION[0], TTS_ACTION[1], K_ARE_YOU_OK);
    await sleep(120);
    console.log('💤 已退出唤醒状态');
  } catch (e) {
    console.warn('⚠️ 退出唤醒失败: ' + (e && e.message));
  }
}
const isChatMode = () => {
  try {
    return fs.existsSync(CHAT_MODE_FILE);
  } catch {
    return false;
  }
};

// 小爱原生回答属于"没答上来"时的兜底识别，命中则改走外接 LLM
function isXiaoAIAnswerFailure(text) {
  return /(?:我(?:还|暂时|暂不|也)?(?:不知道|不知道咋说|不太清楚|不支持|不会|回答不上)|不太清楚|无法(?:回答|理解|获取|处理)|没法回答|回答不了|没听懂|不明白.{0,8}(?:说|意思)|换个问题|我还在学习|(?:你|我).{0,4}(?:问住|难住)了|被难住了(?:诶|呢|呀|哦)?|暂不支持(?:该|此)?功能|不知道咋说|还.{0,4}(?:支持.{0,6}功能|学习)|不如换.{0,6}(?:方式|问题|说)|超出.{0,6}(?:能力|范围)|(?:没有|无法)找到.{0,8}(?:答案|结果|内容)|(?:暂时|还)回答不)/i.test(
    text,
  );
}

// ---------------- 外接 TTS（可自由选择音色）----------------
async function edgeTTS(text, voice, out) {
  // 统一走包装脚本（/root/tts-venv/bin/edge-tts）：它会把请求转给 MiMo 微服务，
  // 并从 editable.json 读取引擎/语速/超时等设置。
  //
  // 不再直连 127.0.0.1:36594：复刻耗时实测 3~30 秒，直连 20 秒超时后会再调包装脚本，
  // 等于同一次合成发两遍请求 —— 既多等一轮，又加重小米服务端负载（正是风控的诱因）。
  const t = E.tts || {};
  const rate = t.rate || '+0%';
  const pitch = t.pitch || '+0Hz';
  const volume = t.volume || '+0%';
  return new Promise((resolve) => {
    execFile(
      EDGE_TTS,
      ['--voice', voice, '--text', text, '--rate', rate, '--pitch', pitch, '--volume', volume, '--write-media', out],
      { timeout: 75000 },
      (err) => {
        if (err) {
          const first = String(err.message || '').split('\n')[0].slice(0, 150);
          const why = err.killed ? '（超过 75 秒上限被杀）' : (err.code ? '（' + err.code + '）' : '');
          console.warn('⚠️ TTS 生成失败' + why + ': ' + first);
        }
        resolve(!err);
      },
    );
  });
}

function cleanOldTts(keepMs = 15 * 60 * 1000) {
  try {
    const now = Date.now();
    for (const f of fs.readdirSync(TTS_DIR)) {
      if (!f.endsWith('.mp3') || f.startsWith('fixed-')) continue;
      const p = path.join(TTS_DIR, f);
      if (now - fs.statSync(p).mtimeMs > keepMs) fs.unlinkSync(p);
    }
  } catch {}
}

// 音箱是「自己去下载」音频的，所以这个地址必须是音箱能访问到的本机地址。
// 正常情况下 editable.json 里的 tts.baseUrl 一定有值；这里的兜底刻意用一个
// 明显不通的域名，而不是某个人的内网 IP —— 免得默默指向别人的网络。
let warnedBaseUrl = false;
function ttsUrl(name) {
  let base = (E.tts?.baseUrl || '').replace(/\/+$/, '');
  if (!base) {
    base = (process.env.MIGPT_PUBLIC_BASE || 'http://migpt-x.invalid:36593').replace(/\/+$/, '');
    if (!warnedBaseUrl) {
      warnedBaseUrl = true;
      console.log('⚠️ 未配置 tts.baseUrl，音箱将无法拉取音频 —— 请在面板「播报音色 → 音频地址前缀」填本机局域网地址');
    }
  }
  return base + '/tts/' + name;
}

// 播报：优先用外接 TTS，失败自动回退到音箱内置语音，保证不会哑巴
async function speak(engine, text, cacheKey) {
  const tts = E.tts || {};
  if (tts.enabled && text) {
    const voice = tts.voice || 'zh-CN-XiaoxiaoNeural';
    try {
      fs.mkdirSync(TTS_DIR, { recursive: true });
      const name = cacheKey
        ? 'fixed-' + cacheKey + '.mp3'
        : 't-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7) + '.mp3';
      const file = path.join(TTS_DIR, name);
      if (!cacheKey || !fs.existsSync(file) || fs.statSync(file).size < 800) {
        const ok = await edgeTTS(text, voice, file);
        if (!ok) throw new Error('edge-tts 生成失败');
      }
      if (!fs.existsSync(file) || fs.statSync(file).size < 800) throw new Error('音频文件为空');
      cleanOldTts();
      const played = await engine.speaker.play({ url: ttsUrl(name) });
      if (played) {
        // 💬 连续聊天模式：等这段播完，补一条唤醒指令，让音箱继续听
        if (isChatMode()) {
          const ms = durMs(file);
          if (ms > 0) await sleep(ms + 700);
          await wakeUp(engine);
        }
        return true;
      }
      throw new Error('player_play_url 未成功');
    } catch (e) {
      if (tts.fallbackToBuiltin === false) throw e;
      console.warn('⚠️ 外接 TTS 失败，回退内置语音: ' + (e && e.message));
    }
  }
  return engine.MiOT.doAction(...TTS_ACTION, text);
}

// ---------------- 面板预览播放通道 ----------------
// 面板把 {ts,url} 写进 cmd.json，这里轮询播放。
// 关键：复用引擎已有的登录会话，绝不新建小米登录（否则会触发风控 70016）
let ENG = null;
let lastCmdTs = 0;
const CMD_FILE = process.env.MIGPT_CMD_FILE || path.join(PANEL_DIR, 'cmd.json');

setInterval(async () => {
  // ENG 只有收到第一条消息后才有值。这里回退到引擎单例（MiGPT 是单例导出），
  // 使面板在还没跟音箱说过话时也能下发指令。
  let eng = ENG;
  if (!eng) {
    try {
      const m = await import('./packages/next/dist/index.js');
      eng = m.MiGPT;
    } catch {
      return;
    }
  }
  if (!eng || !eng.speaker) return;
  try {
    if (!fs.existsSync(CMD_FILE)) return;
    const c = JSON.parse(fs.readFileSync(CMD_FILE, 'utf8'));
    if (!c || !c.ts || c.ts === lastCmdTs) return;
    lastCmdTs = c.ts;
    if (c.action === 'wakeup') {
      console.log('📢 面板触发补唤醒指令');
      await wakeUp(eng, { retry: 20 });
      return;
    }
    console.log('📢 面板试听: ' + c.url);
    if (!(await waitEngineReady(eng, 15))) {
      console.warn('⚠️ 引擎还没登录完成，试听已跳过（刚重启时点太快了）');
      return;
    }
    await eng.speaker.abortXiaoAI().catch(() => {});
    await eng.speaker.play({ url: c.url });
  } catch (e) {
    console.warn('⚠️ 预览播放失败: ' + (e && e.message));
  }
}, 1200);

export default {
  debug: E.debug ?? false,

  speaker: {
    did: E.speaker?.did,
    userId: E.speaker?.userId,
    passToken: E.speaker?.passToken,
    heartbeat: E.speaker?.heartbeat ?? 500,
  },

  openai: {
    baseURL: E.openai?.baseURL,
    apiKey: E.openai?.apiKey,
    model: E.openai?.model,
    enableProxy: E.openai?.enableProxy ?? false,
    extra: {
      ...(E.openai?.disableThinking ? { createParams: { thinking: { type: 'disabled' } } } : {}),
      requestOptions: { timeout: E.openai?.timeout ?? 60000 },
    },
  },

  prompt: {
    system: E.persona,
  },

  context: {
    historyMaxLength: E.historyMaxLength ?? 10,
  },

  stream: {
    maxReplyLength: E.maxReplyLength ?? 100,
  },

  callAIKeywords: E.callAIKeywords,

  async onMessage(engine, msg) {
    ENG = engine;

    // ============ 连续聊天模式 ============
    // 对音箱说「开始聊天」进入，「结束聊天」退出（切换不用重启引擎）。
    const msgText = (msg.text || '').trim();
    const turnOn = /(开始|进入|打开|来).{0,2}(聊天|唠嗑|对话)|聊天模式(开|打开)/.test(msgText);
    const turnOff = /(结束|退出|停止|关闭|不).{0,2}(聊天|唠嗑|对话)|不聊了|聊天模式(关|关闭)/.test(msgText);
    if (turnOn || turnOff) {
      try {
        if (turnOn) fs.writeFileSync(CHAT_MODE_FILE, String(Date.now()));
        else if (fs.existsSync(CHAT_MODE_FILE)) fs.unlinkSync(CHAT_MODE_FILE);
      } catch (e) {
        console.warn('⚠️ 切换聊天模式失败: ' + e.message);
      }
      const reply = turnOn ? '哟西，聊天的干活，放马过来的！' : '哟西，聊天结束的干活，解散！';
      console.log(turnOn ? '💬 进入连续聊天模式' : '💤 退出连续聊天模式');
      try { await engine.speaker.abortXiaoAI(); } catch (e) {}
      console.log(`🔊 ${reply}`);
      // 用固定 cacheKey：首次生成后永久复用 fixed-chatmode-*.mp3，避免现场等 20 多秒
      await speak(engine, reply, turnOn ? 'chatmode-on' : 'chatmode-off');
      if (!turnOn) await unWakeUp(engine);
      return { handled: true };
    }
    const chatMode = isChatMode();

    const nativeAnswer =
      typeof msg.metadata?.xiaoAIAnswer === 'string' ? msg.metadata.xiaoAIAnswer.trim() : '';
    const nativeFailed = !nativeAnswer || isXiaoAIAnswerFailure(nativeAnswer);

    // 聊天模式下，设备控制/播放类指令仍然留给小爱。
    // 否则说「打开客厅的灯」会被大佐用一句玩笑接走，灯根本打不开。
    const isDeviceCmd = /^(打开|关闭|关掉|开一下|关一下|暂停|继续|下一首|上一首|音量|静音|播放)/.test(msgText);
    if (chatMode && isDeviceCmd && !nativeFailed) {
      console.log('🏠 设备指令，交给小爱原生处理');
      return;
    }

    // 关键词命中判定：面板「触发词 → 匹配方式」可切换
    //   start   = 以触发词开头才交给 AI（原版 MiGPT 行为，精确，但「嗯你是谁」这类会漏掉）
    //   contain = 含触发词就交给 AI（灵敏，但容易误触发）
    const kws = engine.config.callAIKeywords || [];
    const kwMode = E.kwMatch === 'start' ? 'start' : 'contain';
    const kwHit = chatMode || kws.length === 0 ||
      kws.some((kw) => kwMode === 'start' ? msgText.startsWith(kw) : msgText.includes(kw));

    // 小爱能正常回答、且没命中关键词 → 交给小爱（保留原生的开灯/放歌等能力）
    // 小爱答不上来（失败回答）→ 无论关键词如何都由 AI 接管
    if (!kwHit && !nativeFailed) {
      return;
    }

    // 聊天模式下不保留原生回答，否则 AI 就不接话了
    if (!chatMode && E.keepNativeAnswer && nativeAnswer && !isXiaoAIAnswerFailure(nativeAnswer)) {
      console.log(`🔈 保留小爱原生回答：${nativeAnswer}`);
      return { handled: true };
    }

    // 1. 打断小爱原生播报
    const stopped = await engine.speaker.abortXiaoAI();
    if (!stopped) {
      console.warn('⚠️ 未能确认已停止小爱原生播报，继续切换外接 LLM');
    }

    // 2. 占位语（音频缓存复用，首次生成后几乎零延迟）
    if (E.placeholder) {
      await speak(engine, E.placeholder, 'placeholder');
    }

    // 3. 问 AI
    const { text } = await engine.askAI(msg, { stream: false });

    // 4. 播报前再清一次原生音频队列
    if (text && E.reStopBeforeReply !== false) {
      await engine.speaker.abortXiaoAI();
    }

    // 5. 播报（外接 TTS 音色）
    if (text) {
      console.log(`🔊 ${text}`);
      await speak(engine, text);
    }

    return { handled: true };
  },
};
