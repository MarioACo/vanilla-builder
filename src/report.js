// Informe de tamaños (original, final, gzip y brotli) por archivo y totales.
import zlib from 'node:zlib';
import { formatBytes } from './util.js';

const COMPRESSIBLE = new Set(['html', 'css', 'js', 'json', 'svg', 'text']);

export function sizesOf(buf, type) {
  const size = buf.length;
  if (!COMPRESSIBLE.has(type) || size === 0) return { size, gzip: null, brotli: null };
  return {
    size,
    gzip: zlib.gzipSync(buf, { level: 9 }).length,
    brotli: zlib.brotliCompressSync(buf, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 } }).length,
  };
}

/** Filas del informe a partir de las salidas. */
export function buildReport(outputs) {
  const rows = [];
  for (const [rel, o] of outputs) {
    if (o.copyFrom) {
      rows.push({ file: rel, type: o.type, action: o.action, sources: o.sources, before: o.size, size: o.size, gzip: null, brotli: null });
      continue;
    }
    const s = sizesOf(o.data, o.type);
    rows.push({ file: rel, type: o.type, action: o.action, sources: o.sources, before: o.before ?? s.size, ...s });
  }
  rows.sort((a, b) => (a.type === b.type ? a.file.localeCompare(b.file) : order(a.type) - order(b.type)));
  const totals = { before: 0, size: 0, gzip: 0, brotli: 0, files: rows.length };
  const byType = {};
  for (const r of rows) {
    totals.before += r.before;
    totals.size += r.size;
    totals.gzip += r.gzip ?? r.size;
    totals.brotli += r.brotli ?? r.size;
    const t = (byType[r.type] ??= { files: 0, before: 0, size: 0 });
    t.files++;
    t.before += r.before;
    t.size += r.size;
  }
  return { rows, totals, byType };
}

const ORDER = ['html', 'js', 'css', 'json', 'svg', 'text', 'asset'];
const order = (t) => (ORDER.includes(t) ? ORDER.indexOf(t) : ORDER.length);

const pct = (before, after) => (before > 0 ? `${(((before - after) / before) * 100).toFixed(1)}%` : '—');

/** Tabla para la terminal. Los recursos copiados sin cambios se resumen en una línea. */
export function renderReport(report, C, { verbose = false } = {}) {
  const lines = [];
  const shown = report.rows.filter((r) => verbose || r.action !== 'copy');
  const hidden = report.rows.filter((r) => !verbose && r.action === 'copy');
  const w = Math.min(60, Math.max(20, ...shown.map((r) => r.file.length)));
  const pad = (s, n) => (s.length > n ? `…${s.slice(-(n - 1))}` : s.padEnd(n));
  const num = (n) => (n == null ? '—' : formatBytes(n)).padStart(10);
  lines.push(C.gray(`${'Archivo'.padEnd(w)}  ${'Antes'.padStart(10)}  ${'Después'.padStart(10)}  ${'gzip'.padStart(10)}  ${'brotli'.padStart(10)}  Ahorro`));
  for (const r of shown) {
    const src = r.sources && r.sources.length > 1 ? C.gray(` (${r.sources.length} archivos)`) : '';
    lines.push(`${pad(r.file, w)}  ${num(r.before)}  ${num(r.size)}  ${num(r.gzip)}  ${num(r.brotli)}  ${pct(r.before, r.size).padStart(6)}${src}`);
  }
  if (hidden.length) {
    const size = hidden.reduce((a, r) => a + r.size, 0);
    lines.push(C.gray(`${pad(`+ ${hidden.length} recursos copiados sin cambios`, w)}  ${num(size)}  ${num(size)}`));
  }
  const t = report.totals;
  lines.push(
    C.bold(`${'Total'.padEnd(w)}  ${num(t.before)}  ${num(t.size)}  ${num(t.gzip)}  ${num(t.brotli)}  ${pct(t.before, t.size).padStart(6)}`),
  );
  return lines.join('\n');
}
