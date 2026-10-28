// Recorre el proyecto y decide qué archivos forman parte del sitio.
import fs from 'node:fs';
import path from 'node:path';
import picomatch from 'picomatch';
import { CONFIG_FILES } from './config.js';
import { relFrom, toPosix, extOf } from './util.js';

/** Archivos de desarrollo que nunca deberían publicarse. Se desactiva con defaultIgnore:false. */
export const DEFAULT_IGNORE = [
  '**/node_modules/**',
  '**/.git/**',
  '**/.svn/**',
  '**/.hg/**',
  '**/.vscode/**',
  '**/.idea/**',
  '**/.DS_Store',
  '**/Thumbs.db',
  '**/desktop.ini',
  '**/*.log',
  'package.json',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'bun.lockb',
  '.gitignore',
  '.gitattributes',
  '.editorconfig',
  '.npmrc',
  '.nvmrc',
  '**/.prettierrc*',
  '**/.eslintrc*',
  '**/eslint.config.*',
  '**/prettier.config.*',
  'tsconfig.json',
  'jsconfig.json',
  '**/*.test.js',
  '**/*.spec.js',
  '**/__tests__/**',
  '**/*.map',
];

/** Secretos: se excluyen siempre por defecto y se avisa. */
export const SECRET_PATTERNS = ['**/.env', '**/.env.*', '**/*.pem', '**/*.key', '**/id_rsa*'];

/** "carpeta/" equivale a "carpeta/**"; "./x" a "x". */
const normalizePattern = (p) => {
  const s = toPosix(p).replace(/^\.\//, '');
  return s.endsWith('/') ? `${s}**` : s;
};
const matcher = (patterns) =>
  patterns.length ? picomatch(patterns.map(normalizePattern), { dot: true, nocase: true }) : () => false;

/**
 * Lista los archivos del proyecto con el motivo de exclusión de cada uno.
 * @returns {{files: Map<string, {rel:string, abs:string, size:number, ext:string}>, ignored: Array<{rel:string, reason:string}>}}
 */
export function scanProject(cfg) {
  const root = cfg.root;
  const outRel = relFrom(root, cfg.outDir);
  const builtIn = [...CONFIG_FILES];
  if (outRel) builtIn.push(`${outRel}/**`, outRel);
  if (cfg.configFile) {
    const rel = relFrom(root, cfg.configFile);
    if (rel) builtIn.push(rel);
  }
  // Carpetas temporales de compilaciones anteriores interrumpidas.
  builtIn.push('**/.*.builder-tmp-*/**', '**/.*.builder-old-*/**');
  const isBuiltIn = matcher(builtIn);
  const isDefault = cfg.defaultIgnore ? matcher(DEFAULT_IGNORE) : () => false;
  const isSecret = cfg.defaultIgnore ? matcher(SECRET_PATTERNS) : () => false;
  const isUser = matcher(cfg.ignore);
  const isIncluded = matcher(cfg.include);

  const files = new Map();
  const ignored = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      ignored.push({ rel: relFrom(root, dir) || '.', reason: `no se pudo leer (${err.code})` });
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      const rel = relFrom(root, abs);
      let isDir = entry.isDirectory();
      let isFile = entry.isFile();
      if (entry.isSymbolicLink()) {
        // Se sigue el enlace a archivos; no a carpetas (evita ciclos).
        try {
          const st = fs.statSync(abs);
          isFile = st.isFile();
          isDir = false;
          if (st.isDirectory()) ignored.push({ rel, reason: 'enlace simbólico a carpeta (no se sigue)' });
        } catch {
          ignored.push({ rel, reason: 'enlace simbólico roto' });
          continue;
        }
      }
      if (isBuiltIn(rel) || isBuiltIn(`${rel}/`)) continue;
      if (isDir) {
        // Las carpetas excluidas no se recorren, salvo que include apunte dentro.
        const probe = `${rel}/__probe__`;
        const byUser = isUser(rel) || isUser(probe);
        const wanted = cfg.include.some((p) => normalizePattern(p).startsWith(`${rel}/`) || p.startsWith('**'));
        if ((byUser || isDefault(probe)) && !wanted) {
          ignored.push({ rel: `${rel}/`, reason: byUser ? 'ignore (configuración)' : 'excluido por defecto' });
          continue;
        }
        walk(abs);
        continue;
      }
      if (!isFile) continue;
      const forced = isIncluded(rel);
      let reason = null;
      if (!forced) {
        if (isSecret(rel)) reason = 'posible secreto (excluido por seguridad)';
        else if (isUser(rel)) reason = 'ignore (configuración)';
        else if (isDefault(rel)) reason = 'excluido por defecto';
      }
      if (reason) {
        ignored.push({ rel, reason });
        continue;
      }
      const size = fs.statSync(abs).size;
      files.set(rel, { rel, abs, size, ext: extOf(rel), forced });
    }
  };
  walk(root);
  return { files, ignored };
}

/** Resuelve patrones (o rutas exactas) contra los archivos del proyecto. */
export function matchFiles(files, patterns) {
  const out = [];
  const missing = [];
  for (const pattern of patterns) {
    const norm = toPosix(pattern).replace(/^\.\//, '');
    if (picomatch.scan(norm).isGlob) {
      const isMatch = picomatch(norm, { dot: true, nocase: true });
      const hits = [...files.keys()].filter((rel) => isMatch(rel));
      if (!hits.length) missing.push(pattern);
      out.push(...hits);
    } else if (files.has(norm)) out.push(norm);
    else missing.push(pattern);
  }
  return { matched: [...new Set(out)], missing };
}

export const globMatcher = matcher;
