// Carga, combina y valida la configuración (builder.config.json / .mjs + opciones de la CLI).
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { BuildError } from './util.js';
import { L } from './i18n.js';
import { resolveBrowsers } from './browsers.js';
import { validateBudgets } from './budgets.js';

export const CONFIG_FILES = ['builder.config.json', 'builder.config.mjs', 'builder.config.js'];

export const DEFAULTS = {
  root: '.',
  outDir: 'dist',
  entries: 'auto',
  include: [],
  ignore: [],
  defaultIgnore: true,
  unreferenced: 'process',
  base: '/',
  hash: false,
  sourcemap: false,
  clean: true,
  verify: true,
  sri: 'auto',
  html: { minify: true, removeComments: true, collapseWhitespace: 'auto' },
  css: { minify: true, bundle: true, target: 'esnext' },
  js: {
    minify: true,
    bundle: true,
    target: 'auto',
    mergeClassic: 'auto',
    keepNames: false,
    drop: [],
    legalComments: 'eof',
    define: {},
    chunkDir: 'assets',
    minifier: 'esbuild',
  },
  json: { minify: true },
  obfuscate: false,
  // Librerías de terceros: se detectan solas y no se ofuscan salvo que se pida.
  dependencies: { detect: true, obfuscate: false, include: [], exclude: [] },
  compress: false,
  // Caché persistente de las transformaciones lentas (ofuscación, terser) entre compilaciones.
  cache: true,
  // Hilos para ofuscar/comprimir en paralelo: "auto" (núcleos - 1, máx. 8), un número, o 0 (sin hilos).
  workers: 'auto',
  // Navegadores objetivo: 'auto' (browserslist del proyecto si existe), false, o una consulta de browserslist.
  browsers: 'auto',
  // Optimizar PNG (sin pérdida) y JPEG/WebP (calidad indicada) con sharp: false, true o { quality: 80 }.
  images: false,
  // Presupuestos de tamaño por patrón de salida (o "total"): { "js/**/*.js": "50 KB", "total": "1 MB gzip" }.
  budgets: false,
};

const NESTED = ['html', 'css', 'js', 'json', 'dependencies'];
const ENUMS = {
  unreferenced: ['process', 'copy', 'skip'],
  sri: ['auto', true, false],
  sourcemap: [false, true, 'hidden', 'inline'],
  'js.mergeClassic': ['auto', true, false],
  'js.legalComments': ['none', 'inline', 'eof'],
  'html.collapseWhitespace': ['auto', true, false],
  'js.minifier': ['esbuild', 'terser'],
  compress: [false, true, 'gzip', 'brotli'],
};
const OBF_PRESETS = ['low', 'medium', 'high', 'max'];

function levenshtein(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}

function suggest(key, options) {
  const best = options.map((o) => [o, levenshtein(key, o)]).sort((x, y) => x[1] - y[1])[0];
  return best && best[1] <= 3 ? L(` ¿Quisiste decir "${best[0]}"?`, ` Did you mean "${best[0]}"?`) : '';
}

function checkKeys(obj, defaults, prefix, errors) {
  for (const key of Object.keys(obj)) {
    if (key === '$schema') continue;
    if (!(key in defaults))
      errors.push(
        L(
          `Opción desconocida "${prefix}${key}".${suggest(key, Object.keys(defaults))}`,
          `Unknown option "${prefix}${key}".${suggest(key, Object.keys(defaults))}`,
        ),
      );
  }
}

const asList = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);

export function normalizeConfig(raw, errors = []) {
  const user = raw ?? {};
  if (typeof user !== 'object' || Array.isArray(user))
    throw new BuildError(L('La configuración debe ser un objeto JSON.', 'The configuration must be a JSON object.'));
  checkKeys(user, DEFAULTS, '', errors);
  const cfg = { ...DEFAULTS, ...user };
  for (const k of NESTED) {
    const v = user[k];
    if (v === false) cfg[k] = k === 'dependencies' ? { ...DEFAULTS[k], detect: false } : { ...DEFAULTS[k], minify: false };
    else if (v === true || v == null) cfg[k] = { ...DEFAULTS[k] };
    else if (typeof v === 'object') {
      checkKeys(v, DEFAULTS[k], `${k}.`, errors);
      cfg[k] = { ...DEFAULTS[k], ...v };
    } else errors.push(L(`"${k}" debe ser un objeto o true/false.`, `"${k}" must be an object or true/false.`));
  }
  for (const k of ['include', 'ignore']) {
    cfg[k] = asList(cfg[k]);
    if (cfg[k].some((x) => typeof x !== 'string'))
      errors.push(L(`"${k}" debe ser una lista de rutas o patrones (texto).`, `"${k}" must be a list of paths or patterns (text).`));
  }
  for (const k of ['include', 'exclude']) {
    cfg.dependencies[k] = asList(cfg.dependencies[k]);
    if (cfg.dependencies[k].some((x) => typeof x !== 'string'))
      errors.push(
        L(`"dependencies.${k}" debe ser una lista de rutas o patrones (texto).`, `"dependencies.${k}" must be a list of paths or patterns (text).`),
      );
  }
  for (const k of ['detect', 'obfuscate'])
    if (typeof cfg.dependencies[k] !== 'boolean')
      errors.push(L(`"dependencies.${k}" debe ser true o false.`, `"dependencies.${k}" must be true or false.`));
  if (cfg.entries !== 'auto') {
    cfg.entries = asList(cfg.entries);
    if (!cfg.entries.length || cfg.entries.some((x) => typeof x !== 'string'))
      errors.push(L('"entries" debe ser "auto" o una lista de archivos/patrones.', '"entries" must be "auto" or a list of files/patterns.'));
  }
  for (const [key, allowed] of Object.entries(ENUMS)) {
    const [a, b] = key.split('.');
    const value = b ? cfg[a][b] : cfg[a];
    if (!allowed.includes(value))
      errors.push(
        L(
          `"${key}" debe ser uno de: ${allowed.map((x) => JSON.stringify(x)).join(', ')}.`,
          `"${key}" must be one of: ${allowed.map((x) => JSON.stringify(x)).join(', ')}.`,
        ),
      );
  }
  if (typeof cfg.outDir !== 'string' || !cfg.outDir.trim()) errors.push(L('"outDir" debe ser una ruta.', '"outDir" must be a path.'));
  if (typeof cfg.base !== 'string' || !cfg.base.startsWith('/'))
    errors.push(L('"base" debe empezar con "/" (ej. "/" o "/mi-sitio/").', '"base" must start with "/" (e.g. "/" or "/my-site/").'));
  else if (!cfg.base.endsWith('/')) cfg.base += '/';
  if (typeof cfg.hash !== 'boolean') errors.push(L('"hash" debe ser true o false.', '"hash" must be true or false.'));
  const b = cfg.browsers;
  if (!(
    b === 'auto' ||
    b === false ||
    (typeof b === 'string' && b.trim()) ||
    (Array.isArray(b) && b.length && b.every((x) => typeof x === 'string'))
  ))
    errors.push(
      L(
        '"browsers" debe ser "auto", false o una consulta de browserslist (texto o lista).',
        '"browsers" must be "auto", false or a browserslist query (text or list).',
      ),
    );
  const im = cfg.images;
  if (!(
    typeof im === 'boolean' ||
    (im &&
      typeof im === 'object' &&
      !Array.isArray(im) &&
      Object.keys(im).every((k) => k === 'quality') &&
      (im.quality === undefined || (Number.isInteger(im.quality) && im.quality >= 1 && im.quality <= 100)))
  ))
    errors.push(L('"images" debe ser true, false o { "quality": 1-100 }.', '"images" must be true, false or { "quality": 1-100 }.'));
  errors.push(...validateBudgets(cfg.budgets));
  if (typeof cfg.cache !== 'boolean') errors.push(L('"cache" debe ser true o false.', '"cache" must be true or false.'));
  if (!(cfg.workers === 'auto' || (Number.isInteger(cfg.workers) && cfg.workers >= 0 && cfg.workers <= 64)))
    errors.push(L('"workers" debe ser "auto" o un número entre 0 y 64.', '"workers" must be "auto" or a number between 0 and 64.'));
  cfg.js.drop = asList(cfg.js.drop);
  if (cfg.js.drop.some((d) => !['console', 'debugger'].includes(d)))
    errors.push(L('"js.drop" solo admite "console" y "debugger".', '"js.drop" only accepts "console" and "debugger".'));
  if (typeof cfg.js.chunkDir !== 'string' || /(^|\/)\.\.(\/|$)|^\//.test(cfg.js.chunkDir))
    errors.push(L('"js.chunkDir" debe ser una carpeta relativa.', '"js.chunkDir" must be a relative folder.'));
  for (const k of ['css', 'js']) {
    const t = cfg[k].target;
    if (!(typeof t === 'string' || (Array.isArray(t) && t.every((x) => typeof x === 'string'))))
      errors.push(
        L(
          `"${k}.target" debe ser texto o lista (ej. "es2020" o ["chrome90","safari15"]).`,
          `"${k}.target" must be text or a list (e.g. "es2020" or ["chrome90","safari15"]).`,
        ),
      );
  }
  const o = cfg.obfuscate;
  if (o === true) cfg.obfuscate = 'medium';
  else if (!(o === false || OBF_PRESETS.includes(o) || (o && typeof o === 'object' && !Array.isArray(o))))
    errors.push(
      L(
        `"obfuscate" debe ser false, true, ${OBF_PRESETS.map((p) => `"${p}"`).join(', ')} o un objeto de opciones de javascript-obfuscator.`,
        `"obfuscate" must be false, true, ${OBF_PRESETS.map((p) => `"${p}"`).join(', ')} or an object of javascript-obfuscator options.`,
      ),
    );
  return cfg;
}

async function readConfigFile(file) {
  if (file.endsWith('.json')) {
    const text = fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
    try {
      return JSON.parse(text);
    } catch (err) {
      throw new BuildError(
        L(
          `No pude leer ${path.basename(file)}: JSON inválido (${err.message}).`,
          `Could not read ${path.basename(file)}: invalid JSON (${err.message}).`,
        ),
      );
    }
  }
  const mod = await import(`${pathToFileURL(file).href}?t=${fs.statSync(file).mtimeMs}`);
  return typeof mod.default === 'function' ? await mod.default() : mod.default;
}

export function findConfigFile(dir) {
  for (const name of CONFIG_FILES) {
    const file = path.join(dir, name);
    if (fs.existsSync(file)) return file;
  }
  return null;
}

/**
 * Resuelve la configuración final.
 * @param {{dir?: string, config?: string, overrides?: object, cwd?: string}} opts
 */
export async function loadConfig({ dir = '.', config, overrides = {}, cwd = process.cwd() } = {}) {
  const projectDir = path.resolve(cwd, dir);
  if (!fs.existsSync(projectDir) || !fs.statSync(projectDir).isDirectory())
    throw new BuildError(L(`La carpeta del proyecto no existe: ${projectDir}`, `The project folder does not exist: ${projectDir}`));
  const configFile = config ? path.resolve(cwd, config) : findConfigFile(projectDir);
  if (config && !fs.existsSync(configFile))
    throw new BuildError(L(`No existe el archivo de configuración: ${configFile}`, `The configuration file does not exist: ${configFile}`));
  const fileCfg = configFile ? await readConfigFile(configFile) : {};
  const merged = mergeOverrides(fileCfg ?? {}, overrides);
  const errors = [];
  const cfg = normalizeConfig(merged, errors);
  if (errors.length) throw new BuildError(L('La configuración tiene errores:', 'The configuration has errors:'), errors);
  const baseDir = configFile ? path.dirname(configFile) : projectDir;
  cfg.root = path.resolve(baseDir, cfg.root);
  if (!fs.existsSync(cfg.root)) throw new BuildError(L(`"root" no existe: ${cfg.root}`, `"root" does not exist: ${cfg.root}`));
  // esbuild resuelve los enlaces simbólicos de lo que importa; si la raíz no es la ruta real, el mismo
  // módulo aparece con dos rutas (pasa en macOS con /tmp → /private/tmp, o al abrir el proyecto por un enlace).
  cfg.root = fs.realpathSync(cfg.root);
  cfg.outDir = path.resolve(cfg.root, cfg.outDir);
  cfg.configFile = configFile;
  // Navegadores objetivo (browserslist): solo cambian los targets que siguen con su valor por defecto.
  cfg.browserTargets = await resolveBrowsers(cfg.root, cfg.browsers);
  const targets = cfg.browserTargets?.targets;
  if (targets?.length) {
    if (cfg.css.target === DEFAULTS.css.target) cfg.css.target = targets;
    if (cfg.js.target === DEFAULTS.js.target) cfg.js.target = targets;
  }
  return cfg;
}

function mergeOverrides(base, over) {
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) {
    if (v === undefined) continue;
    if (NESTED.includes(k) && v && typeof v === 'object' && !Array.isArray(v)) {
      const prev = base[k];
      out[k] = { ...(prev && typeof prev === 'object' ? prev : prev === false ? { minify: false } : {}), ...v };
    } else if (['include', 'ignore'].includes(k)) {
      out[k] = [...asList(base[k]), ...asList(v)];
    } else out[k] = v;
  }
  return out;
}
