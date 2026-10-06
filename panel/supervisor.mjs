// 引擎守护进程 —— 容器里没有 systemd，由它替代 systemctl 的角色。
//
// 职责：
//   1. 拉起 /root/migpt-next-2/start.mjs
//   2. 把引擎的 stdout/stderr 逐行加上 ISO 时间戳写进 engine.log（面板读这个文件）
//   3. 引擎意外退出时自动拉起
//   4. 轮询 control/request 文件，响应面板发来的 restart / stop / start 请求
//
// 为什么用请求文件而不是信号：面板和引擎是兄弟进程，面板没有权限也不应该
// 直接杀引擎（杀了没人负责拉起来）。写文件、守护进程来执行，语义最清晰，
// 也和项目里原有的 cmd.json 机制风格一致。
//
// 面板侧对应实现见 panel/server.mjs 的 svcRequest()，模式为 MIGPT_MODE=local。

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ENGINE_DIR = process.env.MIGPT_ENGINE_DIR || '/root/migpt-next-2';
const RUN_DIR = process.env.MIGPT_RUN_DIR || '/root/migpt-panel/control';
const LOG_FILE = process.env.MIGPT_LOG_FILE || '/root/migpt-panel/engine.log';
const ENTRY = path.join(ENGINE_DIR, 'start.mjs');

const REQ_FILE = path.join(RUN_DIR, 'request');
const PID_FILE = path.join(RUN_DIR, 'engine.pid');
const POLL_MS = 1500;
const RESTART_DELAY_MS = 3000;

fs.mkdirSync(RUN_DIR, { recursive: true });

let child = null;
let stopping = false;   // 收到 stop 请求：当前进程退出后不再拉起
let failures = 0;       // 连续快速失败次数，用来做退避，避免刷日志
let lastStartAt = 0;

// 面板按 "ISO时间戳 消息" 的前缀解析，见 server.mjs 的 readLogRecords()
function log(msg) {
  const line = `${new Date().toISOString()} ${msg}\n`;
  try {
    fs.appendFileSync(LOG_FILE, line);
  } catch {
    process.stdout.write(line);
  }
  process.stdout.write(line);
}

function start(reason) {
  if (child) return;
  log(`🔄 启动引擎${reason ? '（' + reason + '）' : ''}`);
  let proc;
  try {
    proc = spawn(process.execPath, [ENTRY], {
      cwd: ENGINE_DIR,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });
  } catch (e) {
    log(`❌ 无法启动引擎: ${e && e.message}`);
    setTimeout(() => start('启动失败重试'), RESTART_DELAY_MS);
    return;
  }
  child = proc;
  lastStartAt = Date.now();
  try { fs.writeFileSync(PID_FILE, String(proc.pid)); } catch {}

  // 逐行转发：按 \n 切分，避免半行输出污染日志格式
  const pipe = (stream, isErr) => {
    if (!stream) return;
    let buf = '';
    stream.on('data', (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).replace(/\r$/, '');
        buf = buf.slice(i + 1);
        if (line.length) log(line);
      }
      // 防止没有换行的超长输出把内存撑爆
      if (buf.length > 64 * 1024) { log(buf); buf = ''; }
    });
    stream.on('error', (e) => log(`⚠️ ${isErr ? 'stderr' : 'stdout'} 读取异常: ${e && e.message}`));
  };
  pipe(proc.stdout, false);
  pipe(proc.stderr, true);

  proc.on('exit', (code, signal) => {
    child = null;
    try { fs.unlinkSync(PID_FILE); } catch {}
    log(`⚠️ 引擎退出（code=${code} signal=${signal}）`);
    if (stopping) {
      log('🛑 已按请求停止，不再自动拉起');
      return;
    }
    // 活过一分钟算正常运行，重置退避计数；否则按 3/6/12/24/48/60 秒退避重试。
    // 这样配置没填好导致的崩溃循环不会把日志刷爆。
    if (Date.now() - lastStartAt < 60000) failures += 1;
    else failures = 0;
    const delay = Math.min(RESTART_DELAY_MS * 2 ** Math.min(failures, 5), 60000);
    if (failures >= 3) {
      log(`ℹ️ 引擎连续快速退出 ${failures} 次，${Math.round(delay / 1000)} 秒后重试 —— 请检查面板里的配置是否填写正确`);
    }
    setTimeout(() => start('异常退出自动拉起'), delay);
  });
}

function killEngine(signal = 'SIGTERM') {
  if (!child) return false;
  try { child.kill(signal); } catch {}
  return true;
}

function handle(req) {
  log(`📥 收到控制请求: ${req}`);
  if (req === 'restart') {
    stopping = false;
    if (killEngine('SIGTERM')) {
      // exit 回调里会自动拉起
    } else {
      start('引擎未运行');
    }
  } else if (req === 'stop') {
    stopping = true;
    if (!killEngine('SIGTERM')) log('ℹ️ 引擎本来就没在运行');
  } else if (req === 'start') {
    stopping = false;
    if (child) log('ℹ️ 引擎已在运行');
    else start('面板请求启动');
  } else {
    log(`⚠️ 未知请求: ${req}`);
  }
}

setInterval(() => {
  let req = '';
  try { req = fs.readFileSync(REQ_FILE, 'utf8').trim(); } catch { return; }
  if (!req) return;
  try { fs.unlinkSync(REQ_FILE); } catch {}
  handle(req);
}, POLL_MS);

// 容器收到 docker stop 时，先把引擎停干净再退出
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    log(`🛑 守护进程收到 ${sig}，停止引擎…`);
    stopping = true;
    killEngine('SIGTERM');
    setTimeout(() => process.exit(0), 4000);
  });
}

log('🐕 引擎守护进程已启动' + (process.env.MIGPT_DRY_RUN ? '（试运行）' : ''));
if (!process.env.MIGPT_DRY_RUN) start('首次启动');
