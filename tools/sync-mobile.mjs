/** 把移动端（Capacitor WebView）运行所需的 vendor 静态资源同步到 public/vendor/。
 *  这些文件平时由桌面端 Node 服务从 node_modules 映射提供；App 内没有服务，必须本地化。
 *  用法：npm run sync:vendor（mobile:sync 会自动先跑它） */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const jobs = [
  ['node_modules/katex/dist', 'public/vendor/katex'],
  ['node_modules/marked/lib', 'public/vendor/marked'],
  ['node_modules/jszip/dist/jszip.min.js', 'public/vendor/jszip/jszip.min.js'],
];

for (const [src, dst] of jobs) {
  const from = path.join(ROOT, src);
  const to = path.join(ROOT, dst);
  if (!fs.existsSync(from)) {
    console.error('[sync-mobile] 缺少', src, '（先 npm install）');
    process.exit(1);
  }
  const stat = fs.statSync(from);
  if (stat.isDirectory()) {
    fs.rmSync(to, { recursive: true, force: true });
    fs.cpSync(from, to, { recursive: true });
  } else {
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
  }
  console.log('[sync-mobile] synced', dst);
}
