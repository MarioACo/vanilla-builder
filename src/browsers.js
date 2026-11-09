// Navegadores objetivo: lee la consulta de browserslist del proyecto y la convierte en "targets" de esbuild.
// Con ellos esbuild añade los prefijos CSS necesarios (-webkit-…) y adapta la sintaxis moderna de CSS y JS.
import fs from 'node:fs';
import path from 'node:path';
import { importOptional } from './optional.js';
import { BuildError } from './util.js';
import { L } from './i18n.js';

// Nombres de browserslist → motores de esbuild. Los navegadores móviles usan el motor de su versión de escritorio.
const ENGINES = {
  chrome: 'chrome',
  and_chr: 'chrome',
  edge: 'edge',
  firefox: 'firefox',
  and_ff: 'firefox',
  safari: 'safari',
  ios_saf: 'ios',
  opera: 'opera',
};

/** .browserslistrc: las líneas sin sección, o la sección [production] si existe (una compilación es para producción). */
function readRc(file) {
  const sections = new Map([['', []]]);
  let current = '';
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim();
    if (!line) continue;
    const header = /^\[(.+)\]$/.exec(line);
    if (header) {
      // Una cabecera puede nombrar varios entornos: [production staging]
      current = header[1].split(/\s+/).includes('production') ? 'production' : header[1];
      if (!sections.has(current)) sections.set(current, []);
      continue;
    }
    sections.get(current).push(line);
  }
  const chosen = sections.get('production')?.length ? sections.get('production') : sections.get('');
  return chosen.join(', ');
}

function fromPackageField(value) {
  if (typeof value === 'string' || Array.isArray(value)) return value;
  if (value && typeof value === 'object') return value.production ?? value.defaults ?? null;
  return null;
}

/**
 * Busca la consulta de navegadores: la opción "browsers", un .browserslistrc o el campo "browserslist"
 * del package.json más cercano (sin salir del proyecto que contiene ese package.json).
 * @returns {{query: string|string[], from: string}|null}
 */
export function findBrowsersQuery(root, setting) {
  if (setting === false) return null;
  if ((typeof setting === 'string' && setting !== 'auto') || Array.isArray(setting)) return { query: setting, from: 'browsers' };
  for (let dir = root, i = 0; i < 20; i++) {
    const rc = path.join(dir, '.browserslistrc');
    if (fs.existsSync(rc)) return { query: readRc(rc), from: path.relative(root, rc) || '.browserslistrc' };
    const pkgFile = path.join(dir, 'package.json');
    if (fs.existsSync(pkgFile)) {
      try {
        const query = fromPackageField(JSON.parse(fs.readFileSync(pkgFile, 'utf8')).browserslist);
        if (query) return { query, from: `${path.relative(root, pkgFile) || 'package.json'} (browserslist)` };
      } catch {
        // package.json ilegible: sin pistas
      }
      return null; // el package.json marca el límite del proyecto
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

const cmpVersion = (a, b) => {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d;
  }
  return 0;
};

/** Convierte la lista de browserslist ("chrome 109", "ios_saf 18.5-18.7"…) en targets de esbuild (versión mínima por motor). */
export function toEsbuildTargets(list) {
  const min = new Map();
  const ignored = new Set();
  for (const item of list) {
    const [name, version = ''] = item.split(' ');
    const engine = ENGINES[name];
    const v = version.split('-')[0];
    if (!engine || !/^\d+(\.\d+)*$/.test(v)) {
      ignored.add(name);
      continue;
    }
    if (!min.has(engine) || cmpVersion(v, min.get(engine)) < 0) min.set(engine, v);
  }
  return { targets: [...min].map(([engine, v]) => `${engine}${v}`).sort(), ignored: [...ignored].sort() };
}

/**
 * Resuelve los navegadores del proyecto.
 * @returns {Promise<null | {targets: string[], from: string, ignored: string[]} | {missing: true, from: string}>}
 */
export async function resolveBrowsers(root, setting) {
  const found = findBrowsersQuery(root, setting);
  if (!found) return null;
  let browserslist;
  try {
    const mod = await importOptional('browserslist', root, L('para usar los navegadores objetivo', 'to use target browsers'));
    browserslist = mod.default ?? mod;
  } catch (err) {
    // Pedido a propósito en la configuración: es un error. Encontrado en el proyecto: se avisa y se sigue como antes.
    if (found.from === 'browsers') throw err;
    return { missing: true, from: found.from };
  }
  let list;
  try {
    list = browserslist(found.query, { path: root });
  } catch (err) {
    throw new BuildError(
      L(`Consulta de navegadores no válida en ${found.from}: ${err.message}`, `Invalid browsers query in ${found.from}: ${err.message}`),
    );
  }
  const { targets, ignored } = toEsbuildTargets(list);
  return { targets, from: found.from, ignored };
}
