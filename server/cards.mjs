/**
 * 复习卡（间隔重复）：按课次存 downloads/.review/<课程>/<课次>.json
 * 卡片结构：{id, dir, page, kind: star|wrong|ok, text, created, due, interval, ease, reps, lapses}
 */
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, ensureDir } from './paths.mjs';

const DAY = 86400000;
const KINDS = ['star', 'wrong', 'ok', 'qa'];

/** 卡片存放在数据目录下的 .review/（跟着 PPT 走） */
const storeDir = () => path.join(DATA_DIR, '.review');

function safeRel(dir) {
  const parts = String(dir || '').split('/').filter(Boolean)
    .map((p) => p.replace(/[\\/:*?"<>|]/g, ' ').trim());
  if (parts.length === 0) throw new Error('缺少 dir');
  return parts.join('/');
}

const fileOf = (dir) => path.join(storeDir(), `${safeRel(dir)}.json`);

function readCards(dir) {
  try {
    const data = JSON.parse(fs.readFileSync(fileOf(dir), 'utf8'));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function writeCards(dir, cards) {
  const file = fileOf(dir);
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify(cards, null, 2) + '\n', 'utf8');
}

/** 所有存过卡的课次目录 */
function allLessonDirs() {
  const STORE_DIR = storeDir();
  if (!fs.existsSync(STORE_DIR)) return [];
  const out = [];
  for (const course of fs.readdirSync(STORE_DIR, { withFileTypes: true })) {
    if (!course.isDirectory()) continue;
    const dirPath = path.join(STORE_DIR, course.name);
    for (const f of fs.readdirSync(dirPath)) {
      if (f.endsWith('.json')) out.push(`${course.name}/${f.replace(/\.json$/i, '')}`);
    }
  }
  return out;
}

export function listCards({ dir = '', dueOnly = false, limit = 0 } = {}) {
  const targets = dir ? [safeRel(dir)] : allLessonDirs();
  const now = Date.now();
  let cards = [];
  for (const d of targets) cards = cards.concat(readCards(d).map((c) => ({ ...c, dir: c.dir || d })));
  if (dueOnly) cards = cards.filter((c) => !c.due || c.due <= now);
  cards.sort((a, b) => (a.due || 0) - (b.due || 0));
  return limit > 0 ? cards.slice(0, limit) : cards;
}

export function dueCount() {
  return listCards({ dueOnly: true }).length;
}

const normText = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();

export function addCard({ dir, page = null, kind = 'star', text = '', front = '', back = '' }) {
  const rel = safeRel(dir);
  if (!KINDS.includes(kind)) throw new Error(`未知标记类型：${kind}`);
  const cards = readCards(rel);
  const now = Date.now();
  const pageNo = page ? Number(page) : null;
  // 判重：同一课次、同类型、内容相同（问答卡看题干）→ 不重复入队
  const dup = cards.find((c) =>
    c.kind === kind && (
      kind === 'qa'
        ? normText(front) && normText(c.front) === normText(front)
        : normText(text) && normText(c.text) === normText(text) && (c.page || null) === pageNo
    ));
  if (dup) return { ...dup, duplicate: true };
  const card = {
    id: now.toString(36) + Math.random().toString(36).slice(2, 6),
    dir: rel,
    page: page ? Number(page) : null,
    kind,
    text: String(text || '').slice(0, 800),
    front: String(front || '').slice(0, 500),
    back: String(back || '').slice(0, 1200),
    created: now,
    due: now,
    interval: 0,
    ease: 2.5,
    reps: 0,
    lapses: 0,
  };
  cards.push(card);
  writeCards(rel, cards);
  return card;
}

/** 批量导入（AI 出题用），返回新增张数 */
export function addCards(dir, items) {
  let added = 0;
  for (const it of items || []) {
    if (!it || !String(it.front || '').trim()) continue;
    const card = addCard({
      dir,
      page: it.page ?? null,
      kind: it.kind && KINDS.includes(it.kind) ? it.kind : 'qa',
      text: it.source || it.text || '',
      front: String(it.front).slice(0, 500),
      back: String(it.back || '').slice(0, 1200),
    });
    if (!card.duplicate) added++;
  }
  return added;
}

export function gradeCard(id, grade) {
  for (const dir of allLessonDirs()) {
    const cards = readCards(dir);
    const card = cards.find((c) => c.id === id);
    if (!card) continue;
    const now = Date.now();
    if (grade === 'again') {
      card.interval = 0;
      card.ease = Math.max(1.3, card.ease - 0.2);
      card.lapses = (card.lapses || 0) + 1;
      card.due = now + 10 * 60 * 1000;
    } else if (grade === 'hard') {
      card.interval = Math.max(1, Math.round((card.interval || 1) * 1.2));
      card.ease = Math.max(1.3, card.ease - 0.15);
      card.due = now + card.interval * DAY;
    } else if (grade === 'easy') {
      card.interval = Math.max(1, Math.round((card.interval || 1) * card.ease * 1.4));
      card.ease = Math.min(3, card.ease + 0.15);
      card.due = now + card.interval * DAY;
    } else {
      card.interval = Math.max(1, Math.round((card.interval || 1) * card.ease));
      card.due = now + card.interval * DAY;
    }
    card.reps = (card.reps || 0) + 1;
    card.lastGrade = grade;
    writeCards(dir, cards);
    return card;
  }
  return null;
}

export function deleteCard(id) {
  for (const dir of allLessonDirs()) {
    const cards = readCards(dir);
    const idx = cards.findIndex((c) => c.id === id);
    if (idx < 0) continue;
    const [removed] = cards.splice(idx, 1);
    if (cards.length === 0) {
      try { fs.unlinkSync(fileOf(dir)); } catch { /* 忽略 */ }
    } else {
      writeCards(dir, cards);
    }
    return removed;
  }
  return null;
}

const KIND_LABEL = { star: '⭐ 重点', wrong: '❓ 错题', ok: '✅ 已掌握', qa: '🧠 问答' };

/** 导出复习清单：format=md（贴 Obsidian）或 csv（Anki / 表格） */
export function exportCards({ dir = '', format = 'md' } = {}) {
  const cards = listCards({ dir });
  if (format === 'csv') {
    const rows = [['课程', '课次', '页码', '标记', '内容']];
    for (const c of cards) {
      const [course, lesson] = c.dir.split('/');
      rows.push([course, lesson, c.page ?? '', KIND_LABEL[c.kind] || c.kind, String(c.text || '').replace(/\s+/g, ' ')]);
    }
    return rows.map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\r\n') + '\r\n';
  }
  const lines = ['# 复习清单', '', `> 导出时间：${new Date().toLocaleString('zh-CN')} · 共 ${cards.length} 张卡`, ''];
  let lastDir = '';
  for (const c of cards) {
    if (c.dir !== lastDir) {
      lastDir = c.dir;
      lines.push(`## ${c.dir.replace('/', ' · ')}`, '');
    }
    const where = c.page ? `第 ${c.page} 页` : '整节';
    lines.push(`- ${KIND_LABEL[c.kind] || c.kind} · ${where}`);
    if (c.kind === 'qa' && c.front) {
      lines.push(`  - 问：${String(c.front).replace(/\n+/g, ' ')}`);
      if (c.back) lines.push(`  - 答：${String(c.back).replace(/\n+/g, ' ')}`);
    } else if (c.text) {
      lines.push(`  > ${String(c.text).replace(/\n+/g, ' ').slice(0, 300)}`);
    }
  }
  return lines.join('\n') + '\n';
}
