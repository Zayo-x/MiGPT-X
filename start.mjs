import { MiGPT } from './packages/next/dist/index.js';
import config from './config.js';

console.log('🚀 启动 MiGPT-X ...');
MiGPT.start(config).catch((e) => {
  console.error('❌ 启动失败:', e);
  process.exit(1);
});
