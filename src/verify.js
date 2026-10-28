// Verificación de la salida antes de publicarla: referencias, sintaxis, escritura y cobertura.
import fs from 'node:fs';
import path from 'node:path';
import * as acorn from 'acorn';
import * as walk from 'acorn-walk';
import { parseHtml } from './html.js';
import { classifyUrl, parseSrcset } from './urls.js';

function unescapeCss(s) {
  return s.replace(/\\([0-9a-f]{1,6}[ \t\n]?|[\s\S])/gi, (_, e) => (/^[0-9a-f]/i.test(e) ? String.fromCodePoint(parseInt(e, 16)) : e));
}

function stringEnd(css, i) {
  const q = css[i];
  let j = i + 1;
  while (j < css.length && css[j] !== q) j += css[j] === '\\' ? 2 : 1;
  return j;
}

/** URLs de url() e @import de una hoja de estilos. */
export function cssRefs(css) {
  const refs = [];
  let i = 0;
  while (i < css.length) {
    const c = css[i];
    if (c === '/' && css[i + 1] === '*') {
      const e = css.indexOf('*/', i + 2);
      i = e < 0 ? css.length : e + 2;
      continue;
    }
    if (c === '"' || c === "'") {
      const end = stringEnd(css, i);
      if (/@import\s*$/i.test(css.slice(Math.max(0, i - 12), i))) refs.push(unescapeCss(css.slice(i + 1, end)));
      i = end + 1;
      continue;
    }
    if ((c === 'u' || c === 'U') && /^url\(/i.test(css.slice(i, i + 4)) && !/[\w-]/.test(css[i - 1] ?? '')) {
      let j = i + 4;
      while (/\s/.test(css[j] ?? '')) j++;
      if (css[j] === '"' || css[j] === "'") {
        const end = stringEnd(css, j);
        refs.push(unescapeCss(css.slice(j + 1, end)));
        i = end + 1;
        continue;
      }
      let close = j;
      while (close < css.length && css[close] !== ')') close += css[close] === '\\' ? 2 : 1;
      refs.push(unescapeCss(css.slice(j, close).trim()));
      i = close + 1;
      continue;
    }
    i++;
  }
  return refs;
}

function jsImports(code, isModule) {
  const ast = acorn.parse(code, { ecmaVersion: 'latest', sourceType: isModule ? 'module' : 'script', allowHashBang: true });
  const out = [];
  walk.full(ast, (n) => {
    if ((n.type === 'ImportDeclaration' || n.type === 'ExportAllDeclaration' || n.type === 'ExportNamedDeclaration') && n.source) out.push(n.source.value);
    if (n.type === 'ImportExpression' && n.source.type === 'Literal' && typeof n.source.value === 'string') out.push(n.source.value);
  });
  return out;
}

/**
 * @param {string} staging carpeta temporal escrita
 * @param {Map<string, object>} outputs archivos generados (rel → {data|copyFrom, type, size})
 * @param {object} ctx contexto del builder (base, referencias rotas en el origen, cobertura)
 */
export async function verifyOutput(staging, outputs, ctx) {
  const errors = [];
  const warnings = [];
  const stats = { files: 0, html: 0, css: 0, js: 0, refs: 0 };
  const lower = new Map([...outputs.keys()].map((k) => [k.toLowerCase(), k]));
  const exists = (rel) => outputs.has(rel);
  const check = (fromRel, url, baseDir, { page = false, srcset = false } = {}) => {
    const urls = srcset ? parseSrcset(url).map((c) => c.url) : [url];
    for (const u of urls) {
      const info = classifyUrl(u);
      if (info.type !== 'root' && info.type !== 'relative') continue;
      if (ctx.brokenValues.has(u)) continue; // ya estaba rota en el código fuente
      stats.refs++;
      let rel;
      if (info.type === 'root') {
        if (!info.path.startsWith(ctx.cfg.base)) continue;
        rel = info.path.slice(ctx.cfg.base.length);
      } else rel = path.posix.normalize(path.posix.join(baseDir || '.', info.path));
      rel = rel.replace(/^\.\/?/, '');
      const candidates = rel === '' || rel.endsWith('/') ? [`${rel}index.html`] : page ? [rel, `${rel}/index.html`, `${rel}.html`] : [rel];
      if (candidates.some(exists)) continue;
      const ci = candidates.map((c) => lower.get(c.toLowerCase())).find(Boolean);
      errors.push(`${fromRel}: la referencia "${u}" no existe en la salida${ci ? ` (existe "${ci}" con otras mayúsculas)` : ''}.`);
    }
  };

  for (const [rel, o] of outputs) {
    stats.files++;
    const dest = path.join(staging, rel);
    let st;
    try {
      st = fs.statSync(dest);
    } catch {
      errors.push(`${rel}: no se escribió en disco.`);
      continue;
    }
    const expected = o.copyFrom ? o.size : Buffer.byteLength(o.data);
    if (st.size !== expected) errors.push(`${rel}: tamaño en disco ${st.size} ≠ esperado ${expected}.`);
    if (o.copyFrom) continue;
    const dir = path.posix.dirname(rel) === '.' ? '' : path.posix.dirname(rel);
    if (o.type === 'html') {
      stats.html++;
      const text = o.encoding === 'latin1' ? o.data.toString('latin1') : o.data.toString('utf8');
      const model = parseHtml(text);
      const baseDir = o.baseDir ?? dir;
      if (o.baseExternal) continue;
      for (const s of model.scripts) {
        if (s.src) check(rel, s.src.value, baseDir);
        if (s.inline && s.kind === 'module') {
          try {
            for (const spec of jsImports(s.inline.code, true)) if (/^\.{0,2}\//.test(spec)) check(rel, spec, baseDir);
          } catch (err) {
            errors.push(`${rel}: un <script type="module"> inline no es JS válido (${err.message}).`);
          }
        }
      }
      for (const l of model.links) if (l.type === 'stylesheet' || l.type === 'asset' || l.type === 'preload') check(rel, l.href.value, baseDir);
      for (const r of model.refs) if (!r.soft) check(rel, r.value, baseDir, { page: r.kind === 'page', srcset: r.kind === 'srcset' });
    } else if (o.type === 'css') {
      stats.css++;
      for (const u of cssRefs(o.data.toString('utf8'))) check(rel, u, dir);
    } else if (o.type === 'js') {
      stats.js++;
      try {
        for (const spec of jsImports(o.data.toString('utf8'), !!o.module)) if (/^\.{0,2}\//.test(spec)) check(rel, spec, dir);
      } catch (err) {
        errors.push(`${rel}: el JavaScript generado no es válido (${err.message}).`);
      }
    }
  }

  const missing = [...ctx.files.keys()].filter((rel) => !ctx.coverage.has(rel));
  for (const rel of missing) errors.push(`${rel}: Builder no registró qué hizo con este archivo (no se publicaría).`);
  return { errors, warnings, stats };
}
