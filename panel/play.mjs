// 用法: node play.mjs <音频URL>
//
// 不写死任何个人路径和设备 ID：
//   引擎目录    MIGPT_ENGINE_DIR   （默认 /root/migpt-next-2）
//   数据目录    MIGPT_DATA_DIR     （默认等于引擎目录）
//   设备 ID     从 .mi.json 登录缓存里取，取不到就报错退出
import fs from 'node:fs';
import path from 'node:path';

const ENGINE_DIR = process.env.MIGPT_ENGINE_DIR || '/root/migpt-next-2';
const DATA_DIR = process.env.MIGPT_DATA_DIR || ENGINE_DIR;

process.chdir(ENGINE_DIR);

const url = process.argv[2];
if (!url) { console.log('缺少 URL'); process.exit(1); }

const { getMiNA } = await import(path.join(ENGINE_DIR, 'packages/miot/dist/index.js'));

const miPath = path.join(DATA_DIR, '.mi.json');
if (!fs.existsSync(miPath)) {
  console.log('❌ 找不到登录缓存 ' + miPath + '，请先让引擎成功登录一次');
  process.exit(1);
}
const acc = (JSON.parse(fs.readFileSync(miPath, 'utf8')).mina) || {};
if (!acc.userId || !acc.did || !acc.passToken) {
  console.log('❌ 登录缓存里缺少 userId / did / passToken');
  process.exit(1);
}

const mina = await getMiNA({ userId: acc.userId, did: acc.did, passToken: acc.passToken, timeout: 8000 });
if (!mina) { console.log('❌ 登录失败'); process.exit(1); }

await mina.stop().catch(() => {});
await new Promise((r) => setTimeout(r, 300));
const ok = await mina.play({ url });
console.log(ok ? '✅ 已开始播放' : '❌ 播放失败');
process.exit(ok ? 0 : 1);
