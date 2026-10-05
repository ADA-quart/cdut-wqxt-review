/**
 * 显卡探测 + 转 MD 并行度自适应。
 *
 * 实测（Tesla V100 16G，2026-10，Pix2Text 全链路）：
 *   parallel=1 → 峰值 6.35 GB；parallel=4 → 9.52 GB
 *   即：模型基座 + 单页 ≈ 6.3 GB，每多并行一页 +1.05 GB
 *
 * 策略：留 1.5 GB 余量给桌面/其他进程，按剩余显存算能塞几页；
 * 再按 CPU 核数收一收（并行时会同时跑 CPU 预处理与回落的算子）。
 */
import os from 'node:os';
import { execFile } from 'node:child_process';

const BASE_MB = 6300;      // 模型 + 第一页
const PER_PAGE_MB = 1050;  // 每多一页
const RESERVE_MB = 1500;   // 给系统留的余量
const MAX_PARALLEL = 4;

function run(cmd, args, timeout = 5000) {
  return new Promise((resolve) => {
    try {
      execFile(cmd, args, { timeout, windowsHide: true }, (err, stdout) => {
        resolve(err ? null : String(stdout || ''));
      });
    } catch {
      resolve(null);
    }
  });
}

let cachedGpu = null;
let cachedAt = 0;

/** 探测 NVIDIA 显卡（nvidia-smi；Mac / 无 N 卡返回 null） */
export async function detectGpu({ fresh = false } = {}) {
  if (!fresh && cachedGpu !== null && Date.now() - cachedAt < 30000) return cachedGpu;
  const out = await run('nvidia-smi', ['--query-gpu=name,memory.total,memory.free', '--format=csv,noheader,nounits']);
  cachedAt = Date.now();
  cachedGpu = null;
  if (out) {
    const line = out.trim().split('\n')[0];
    const parts = line.split(',').map((s) => s.trim());
    if (parts.length >= 3) {
      const totalMB = Number(parts[1]);
      const freeMB = Number(parts[2]);
      if (Number.isFinite(totalMB) && totalMB > 0) {
        cachedGpu = { name: parts[0], totalMB, freeMB };
        return cachedGpu;
      }
    }
  }
  return cachedGpu;
}

/**
 * 计算单节内并行页数。
 * 有 N 卡：按空闲显存算；Mac（MPS，显存=内存）：按核数保守给 2；纯 CPU：按核数给。
 */
export async function autoParallel() {
  const cores = os.cpus().length || 4;
  const cpuLimit = Math.min(MAX_PARALLEL, Math.max(1, Math.floor(cores / 4)));
  const gpu = await detectGpu();

  if (gpu) {
    const usable = gpu.freeMB - RESERVE_MB - BASE_MB;
    const byVram = usable <= 0 ? 1 : 1 + Math.floor(usable / PER_PAGE_MB);
    const parallel = Math.max(1, Math.min(MAX_PARALLEL, byVram, Math.max(cpuLimit, 1)));
    const reason = `${gpu.name} 空闲 ${(gpu.freeMB / 1024).toFixed(1)}G / 共 ${(gpu.totalMB / 1024).toFixed(0)}G`
      + `，模型基座约 ${(BASE_MB / 1024).toFixed(1)}G、每页约 ${(PER_PAGE_MB / 1024).toFixed(2)}G`
      + `，CPU ${cores} 核`;
    return { parallel, reason, gpu: gpu.name, vramMB: gpu.freeMB, cores };
  }

  const isMac = process.platform === 'darwin';
  const parallel = isMac ? Math.min(2, cpuLimit) : cpuLimit;
  const reason = isMac
    ? `macOS（MPS 与内存共享，保守取 ${parallel}），CPU ${cores} 核`
    : `没有检测到 N 卡，按 CPU ${cores} 核取 ${parallel}`;
  return { parallel: Math.max(1, parallel), reason, gpu: null, vramMB: null, cores };
}
