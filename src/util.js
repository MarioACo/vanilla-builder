// Utilidades compartidas: rutas, hashes, codificación y errores.
import crypto from 'node:crypto';
import path from 'node:path';

export class BuildError extends Error {
  constructor(message, details = []) {
    super(message);
    this.name = 'BuildError';
    this.details = details;
  }
}

export const toPosix = (p) => p.split(path.sep).join('/');

/** Ruta relativa POSIX de `abs` respecto a `root`; null si queda fuera. */
export function relFrom(root, abs) {
  const rel = path.relative(root, abs);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return rel === '' ? '' : null;
  return toPosix(rel);
}

export const isInside = (parent, child) => {
  const rel = path.relative(parent, child);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
};

export function sha256(data) {
  return crypto.createHash('sha256').update(data).digest();
}

/** Hash corto y estable (hexadecimal) para nombres de archivo. */
export const shortHash = (data, length = 8) => sha256(data).toString('hex').slice(0, length);

export function sri(data, algo = 'sha384') {
  return `${algo}-${crypto.createHash(algo).update(data).digest('base64')}`;
}

const strictDecoder = new TextDecoder('utf-8', { fatal: true });

/** Devuelve el texto si el buffer es UTF-8 válido; null si no (se copiará tal cual). */
export function decodeUtf8(buf) {
  try {
    return strictDecoder.decode(buf);
  } catch {
    return null;
  }
}

export const BOM = '﻿';
export function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? { text: text.slice(1), bom: true } : { text, bom: false };
}

export const extOf = (p) => path.posix.extname(p).toLowerCase();

export const JS_EXT = new Set(['.js', '.mjs', '.cjs']);
export const CSS_EXT = new Set(['.css']);
export const HTML_EXT = new Set(['.html', '.htm']);
export const JSON_EXT = new Set(['.json', '.webmanifest', '.map']);

/** Ruta URL relativa de un archivo de salida a otro (ambos relativos a outDir, POSIX). */
export function relativeUrl(fromFileRel, toFileRel) {
  const fromDir = path.posix.dirname(fromFileRel);
  let rel = path.posix.relative(fromDir === '.' ? '' : fromDir, toFileRel);
  if (!rel.startsWith('.')) rel = `./${rel}`;
  return encodePath(rel);
}

/** Prefijo relativo desde el directorio de un archivo hasta la raíz de salida ("." o "../.."). */
export function rootPrefix(fromFileRel) {
  const depth = path.posix.dirname(fromFileRel) === '.' ? 0 : path.posix.dirname(fromFileRel).split('/').length;
  return depth === 0 ? '.' : Array(depth).fill('..').join('/');
}

export const encodePath = (p) => p.split('/').map((seg) => (seg === '.' || seg === '..' ? seg : encodeURIComponent(seg))).join('/');

export function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Reintenta operaciones de disco que en Windows/OneDrive fallan por bloqueos momentáneos. */
export async function retryFs(fn, attempts = 12) {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i >= attempts - 1 || !['EPERM', 'EBUSY', 'EACCES', 'ENOTEMPTY', 'EEXIST'].includes(err.code)) throw err;
      await sleep(50 * (i + 1));
    }
  }
}

export const unique = (arr) => [...new Set(arr)];

/** Quita espacios fuera de las cadenas de un JSON válido. No toca ningún valor (sin pérdida). */
export function minifyJsonText(text) {
  try {
    JSON.parse(text);
  } catch {
    return null;
  }
  let out = '';
  let inStr = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      out += c;
      if (c === '\\') out += text[++i];
      else if (c === '"') inStr = false;
    } else if (c === '"') {
      inStr = true;
      out += c;
    } else if (c !== ' ' && c !== '\t' && c !== '\n' && c !== '\r') out += c;
  }
  return out;
}
