// GitHub Action: convierte el informe JSON de `builder build --json` en un resumen Markdown
// (página de la ejecución, salidas del paso y, si se pide, un comentario en el PR que se actualiza).
// Uso: node summary.mjs <report.json>   — sin dependencias, Node 18+.
import fs from 'node:fs';

const MARKER = '<!-- vanilla-builder-report -->';
const kb = (n) => (n == null ? '—' : n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(2)} MB`);
const pct = (before, after) => (before > 0 ? `${(((before - after) / before) * 100).toFixed(1)}%` : '—');
const esc = (s) => String(s).replace(/\|/g, '\\|').replace(/</g, '&lt;');

export function renderSummary(report, { directory = '.', maxRows = 15 } = {}) {
  const title = `### 📦 vanilla-builder${directory && directory !== '.' ? ` — \`${directory}\`` : ''}`;
  if (!report || report.ok === false) {
    const details = (report?.details ?? []).map((d) => `- ${esc(d)}`).join('\n');
    return `${MARKER}\n${title}\n\n❌ **Build failed:** ${esc(report?.error ?? 'no report was produced')}\n${details ? `\n${details}\n` : ''}`;
  }
  const t = report.totals;
  const lines = [MARKER, title, ''];
  lines.push(
    `✅ **${t.files} files** · ${kb(t.before)} → **${kb(t.size)}** (${pct(t.before, t.size)} smaller) · gzip ${kb(t.gzip)} · brotli ${kb(t.brotli)}`,
  );
  const v = report.verify?.stats;
  if (v) lines.push(`✅ Verified: ${v.refs} references, ${v.js} JavaScript files, 0 errors`);
  if (report.budgets?.checked) lines.push(`✅ Budgets: ${report.budgets.checked} checked, all within limits`);
  if (report.durationMs != null) lines.push(`⏱️ ${(report.durationMs / 1000).toFixed(2)} s`);
  const rows = (report.outputs ?? [])
    .filter((r) => r.action !== 'copy')
    .sort((a, b) => b.size - a.size)
    .slice(0, maxRows);
  if (rows.length) {
    lines.push(
      '',
      '<details><summary>Largest processed files</summary>',
      '',
      '| File | Before | After | gzip | brotli | Saved |',
      '| --- | ---: | ---: | ---: | ---: | ---: |',
    );
    for (const r of rows)
      lines.push(`| \`${esc(r.file)}\` | ${kb(r.before)} | ${kb(r.size)} | ${kb(r.gzip)} | ${kb(r.brotli)} | ${pct(r.before, r.size)} |`);
    lines.push('', '</details>');
  }
  if (report.warnings?.length) {
    lines.push('', `<details><summary>⚠️ ${report.warnings.length} warning(s)</summary>`, '');
    for (const w of report.warnings.slice(0, 50)) lines.push(`- ${esc(w)}`);
    lines.push('', '</details>');
  }
  return `${lines.join('\n')}\n`;
}

async function comment(body) {
  const token = process.env.INPUT_TOKEN;
  const repo = process.env.GITHUB_REPOSITORY;
  const event = process.env.GITHUB_EVENT_PATH ? JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8')) : {};
  const pr = event.pull_request?.number;
  if (!pr || !token || !repo) return console.log('Not a pull request: no comment posted.');
  const api = process.env.GITHUB_API_URL || 'https://api.github.com';
  const headers = { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'content-type': 'application/json' };
  const list = await fetch(`${api}/repos/${repo}/issues/${pr}/comments?per_page=100`, { headers });
  if (!list.ok)
    return console.log(`::warning title=vanilla-builder::Could not read PR comments (${list.status}). Does the job have pull-requests: write?`);
  const existing = (await list.json()).find((c) => c.body?.includes(MARKER));
  const url = existing ? `${api}/repos/${repo}/issues/comments/${existing.id}` : `${api}/repos/${repo}/issues/${pr}/comments`;
  const res = await fetch(url, { method: existing ? 'PATCH' : 'POST', headers, body: JSON.stringify({ body }) });
  if (!res.ok) console.log(`::warning title=vanilla-builder::Could not post the PR comment (${res.status}).`);
}

async function main() {
  const file = process.argv[2];
  let report = null;
  try {
    report = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    // sin informe: se muestra como fallo
  }
  const md = renderSummary(report, { directory: process.env.INPUT_DIRECTORY });
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md);
  else process.stdout.write(md);
  if (process.env.GITHUB_OUTPUT && report?.totals)
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `total-size=${report.totals.size}\ntotal-gzip=${report.totals.gzip}\n`);
  if (process.env.INPUT_COMMENT === 'true') await comment(md);
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop())) await main();
