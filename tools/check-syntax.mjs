/** 语法自检：遍历 server / public / electron / tools 的 JS 文件跑 node --check。用法：npm test */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const files = [];
for (const dir of ['server', 'public', 'electron', 'tools']) {
  const abs = path.join(root, dir);
  if (!fs.existsSync(abs)) continue;
  for (const f of fs.readdirSync(abs)) {
    if (/\.(mjs|js|cjs)$/.test(f)) files.push(path.join(abs, f));
  }
}

let bad = 0;
for (const f of files) {
  try {
    execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' });
    console.log('✓', path.relative(root, f));
  } catch (e) {
    bad += 1;
    console.error('✗', path.relative(root, f));
    console.error(String(e.stderr || e.message).slice(0, 400));
  }
}
console.log(`\n${files.length} 个 JS 文件，${bad} 个语法错误`);
process.exit(bad ? 1 : 0);
