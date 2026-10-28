
const fs = require('fs');
const path = require('path');
const ASAR = '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar';
const fd = fs.openSync(ASAR, 'r');
// find json start
const probe = Buffer.alloc(64); fs.readSync(fd, probe, 0, 64, 0);
const jsonStart = probe.indexOf(Buffer.from('{"files"')); 
// read json end by brace scan
const CH = 1<<20; let pos = jsonStart, depth = 0, inStr = false, esc = false, end = -1;
const chunk = Buffer.alloc(CH);
outer: while (true) {
  const n = fs.readSync(fd, chunk, 0, CH, pos);
  if (!n) break;
  for (let i = 0; i < n; i++) {
    const c = chunk[i];
    if (esc) { esc = false; continue; }
    if (c === 92 && inStr) { esc = true; continue; }
    if (c === 34) { inStr = !inStr; continue; }
    if (!inStr) {
      if (c === 123) depth++;
      else if (c === 125) { depth--; if (depth === 0) { end = pos + i + 1; break outer; } }
    }
  }
  pos += n;
}
const header = JSON.parse(fs.readFileSync(ASAR).subarray(jsonStart, end).toString('utf8'));
const dataStart = Math.ceil(end / 4) * 4;
const entries = [];
function walk(node, prefix) {
  for (const [name, e] of Object.entries(node.files || {})) {
    const p = prefix + '/' + name;
    if (e.files) walk(e, p);
    else if (e.link) entries.push({ p, link: e.link });
    else entries.push({ p, offset: Number(e.offset), size: e.size, unpacked: !!e.unpacked });
  }
}
walk(header, '');
function read(e) {
  if (e.unpacked) return fs.readFileSync(path.join(ASAR + '.unpacked', e.p));
  const b = Buffer.alloc(e.size); fs.readSync(fd, b, 0, e.size, dataStart + e.offset); return b;
}
const mode = process.argv[2];
if (mode === 'list') {
  const q = process.argv[3] ? new RegExp(process.argv[3], 'i') : null;
  for (const e of entries) if (!q || q.test(e.p)) console.log(e.p + (e.link ? ' -> ' + e.link : '') + (e.unpacked ? ' [unpacked]' : ''));
} else if (mode === 'cat') {
  const e = entries.find(x => x.p === process.argv[3]);
  if (!e) { console.error('not found: ' + process.argv[3]); process.exit(2); }
  process.stdout.write(read(e));
} else if (mode === 'extract') {
  const outDir = process.argv[4];
  const sel = entries.filter(x => x.p.startsWith(process.argv[3]) && !x.link);
  for (const e of sel) {
    const dest = path.join(outDir, e.p);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, read(e));
  }
  console.error('extracted ' + sel.length + ' files to ' + outDir);
} else if (mode === 'grep') {
  const q = new RegExp(process.argv[3], 'i');
  for (const e of entries) {
    if (e.size > 3_000_000) continue;
    try { const b = read(e); if (q.test(b.toString('utf8'))) console.log(e.p); } catch {}
  }
}
fs.closeSync(fd);