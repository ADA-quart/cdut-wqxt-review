const fs = require('fs');
const p = 'public/review.js';
let t = fs.readFileSync(p, 'utf8');
const edits = [
  ['const res = await fetch(fileUrl(`${rel}.md`));', 'const res = await fetch(noteUrl(`${rel}.md`));'],
  ["window.open(fileUrl(`${courseDir}/${courseName}.md`), '_blank');", "window.open(noteUrl(`${courseDir}/${courseName}.md`), '_blank');"],
  ["window.open(fileUrl(`${node.id}/${node.id}.md`), '_blank');", "window.open(noteUrl(`${node.id}/${node.id}.md`), '_blank');"],
  ['if (!s.page) return fileUrl(s.rel);', 'if (!s.page) return noteUrl(s.rel);'],
  ["el.onclick = () => window.open(fileUrl(b.rel), '_blank');", "el.onclick = () => window.open(noteUrl(b.rel), '_blank');"],
  [': fileUrl(p.rel);', ': noteUrl(p.rel);'],
];
for (const [a, b] of edits) {
  if (!t.includes(a)) { console.log('MISS:', a.slice(0, 60)); process.exit(1); }
  t = t.replace(a, b);
}
fs.writeFileSync(p, t, 'utf8');
console.log('review.js updated');
