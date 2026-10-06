// 强制静音音箱：停止播放 + 用 TTS 抢占音频流 + 再停一次
// 用 MiGPT-Next 自带的 @mi-gpt/miot（支持仅 passToken 登录，不触发异地风控）
//
// 路径和设备 ID 都不写死：
//   MIGPT_ENGINE_DIR  引擎目录（默认 /root/migpt-next-2）
//   MIGPT_DATA_DIR    数据目录（默认等于引擎目录）
//   设备 ID 优先取 .mi.json 登录缓存，其次读 editable.json 的 speaker.did
import fs from 'node:fs';
import path from 'node:path';

const ENGINE_DIR = process.env.MIGPT_ENGINE_DIR || '/root/migpt-next-2';
const DATA_DIR = process.env.MIGPT_DATA_DIR || ENGINE_DIR;

process.chdir(ENGINE_DIR);

const { getMiNA } = await import(path.join(ENGINE_DIR, 'packages/miot/dist/index.js'));

const miPath = path.join(DATA_DIR, '.mi.json');
if (!fs.existsSync(miPath)) {
  console.log('❌ 找不到登录缓存 ' + miPath + '，请先让引擎成功登录一次');
  process.exit(1);
}
const acc = (JSON.parse(fs.readFileSync(miPath, 'utf8')).mina) || {};

// 设备 ID 是个人隐私信息，绝不硬编码。登录缓存里没有就回落到面板配置。
let did = acc.did || '';
if (!did) {
  try {
    did = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'editable.json'), 'utf8')).speaker?.did || '';
  } catch {}
}
if (!acc.userId || !did || !acc.passToken) {
  console.log('❌ 拿不到完整的登录信息（userId / 设备 ID / passToken），请在面板里配置后再试');
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const mina = await getMiNA({ userId: acc.userId, did, passToken: acc.passToken, timeout: 8000 });
if (!mina) {
  console.log('❌ 登录失败');
  process.exit(1);
}
const before = await mina.getStatus().catch(() => null);
await mina.stop().catch(() => {});
await sleep(700);
await mina.callUbus('mibrain', 'text_to_speech', { text: '已停止', save: 0 }).catch(() => {});
await sleep(2200);
await mina.stop().catch(() => {});
await sleep(600);
const after = await mina.getStatus().catch(() => null);
console.log('静音前: ' + JSON.stringify(before));
console.log('静音后: ' + JSON.stringify(after));
process.exit(0);
