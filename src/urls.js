// Clasificación y resolución de referencias (URLs) a archivos del proyecto.
import path from 'node:path';

const SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const DYNAMIC = /\{\{|\$\{|<%|<\?|\{%/;

/**
 * Clasifica una URL tal como aparece en el código fuente.
 * type: empty | fragment | external | dynamic | root | relative
 */
export function classifyUrl(raw) {
  const value = String(raw ?? '').trim();
  if (!value) return { type: 'empty', value };
  if (value.startsWith('#')) return { type: 'fragment', value };
  if (DYNAMIC.test(value)) return { type: 'dynamic', value };
  if (value.startsWith('//') || value.startsWith('\\\\') || SCHEME.test(value)) return { type: 'external', value };
  const cut = value.search(/[?#]/);
  const rawPath = (cut === -1 ? value : value.slice(0, cut)).replace(/\\/g, '/');
  const suffix = cut === -1 ? '' : value.slice(cut);
  let decoded;
  try {
    decoded = decodeURIComponent(rawPath);
  } catch {
    decoded = rawPath;
  }
  return { type: rawPath.startsWith('/') ? 'root' : 'relative', value, path: decoded, rawPath, suffix };
}

/**
 * Resuelve una referencia a un archivo del proyecto.
 * @param {string} raw URL encontrada
 * @param {string} baseDir carpeta (relativa a root, POSIX) contra la que se resuelven las rutas relativas
 * @param {{files: Map, ignoredSet?: Set, base: string}} ctx
 * @param {{page?: boolean}} [opts] page: intenta también carpeta/index.html y ruta.html
 * @returns {{status: 'ok'|'missing'|'ignored'|'outside'|'skip', rel?: string, info: object}}
 */
export function resolveRef(raw, baseDir, ctx, opts = {}) {
  const info = classifyUrl(raw);
  if (info.type !== 'root' && info.type !== 'relative') return { status: 'skip', info };
  let rel;
  if (info.type === 'root') {
    const base = ctx.base || '/';
    if (info.path.startsWith(base)) rel = info.path.slice(base.length);
    else if (`${info.path}/` === base) rel = '';
    else return { status: 'outside', info };
  } else {
    rel = path.posix.join(baseDir || '.', info.path);
  }
  rel = path.posix.normalize(rel);
  if (rel === '.' || rel === './') rel = '';
  if (rel === '..' || rel.startsWith('../')) return { status: 'outside', info };
  const isDirLike = rel === '' || rel.endsWith('/') || info.path.endsWith('/');
  const candidates = [];
  if (!isDirLike) candidates.push(rel);
  if (opts.page || isDirLike) {
    const dir = rel.replace(/\/$/, '');
    candidates.push(dir ? `${dir}/index.html` : 'index.html');
    if (!isDirLike && !path.posix.extname(rel)) candidates.push(`${rel}.html`);
  }
  const lowerMap = ctx.lowerMap;
  for (const c of candidates) {
    if (ctx.files.has(c)) return { status: 'ok', rel: c, info };
  }
  for (const c of candidates) {
    if (ctx.ignoredSet?.has(c)) return { status: 'ignored', rel: c, info };
    // Diferencia solo de mayúsculas: en Windows funciona, en un servidor Linux no.
    const ci = lowerMap?.get(c.toLowerCase());
    if (ci) return { status: 'case', rel: ci, info };
  }
  return { status: 'missing', rel: candidates[0] ?? rel, info };
}

/** Divide un atributo srcset en candidatos {url, start, end} (posiciones relativas al valor). */
export function parseSrcset(value) {
  const out = [];
  let i = 0;
  const n = value.length;
  const isWs = (c) => c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f';
  while (i < n) {
    while (i < n && (isWs(value[i]) || value[i] === ',')) i++;
    if (i >= n) break;
    const start = i;
    while (i < n && !isWs(value[i])) i++;
    let end = i;
    let url = value.slice(start, end);
    let hasDescriptor = true;
    if (url.endsWith(',')) {
      while (url.endsWith(',')) url = url.slice(0, -1);
      end = start + url.length;
      hasDescriptor = false;
    }
    if (url) out.push({ url, start, end });
    if (hasDescriptor) {
      let depth = 0;
      while (i < n) {
        const c = value[i];
        if (c === '(') depth++;
        else if (c === ')') depth = Math.max(0, depth - 1);
        else if (c === ',' && depth === 0) break;
        i++;
      }
    }
  }
  return out;
}
