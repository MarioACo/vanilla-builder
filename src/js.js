// JavaScript: módulos (empaquetado con esbuild), scripts clásicos y archivos sueltos.
import path from 'node:path';
import fs from 'node:fs';
import * as esbuild from 'esbuild';
import * as acorn from 'acorn';
import * as walk from 'acorn-walk';
import { analyzeJs, compareGlobals, moduleShape } from './jsinfo.js';
import { obfuscateSafe } from './obfuscate.js';
import { importOptional } from './optional.js';
import { replaceWithMap } from './sourcemap.js';
import { relFrom, toPosix, BuildError, rootPrefix, hasOwn, shortHash } from './util.js';
import { classifyUrl } from './urls.js';
import { formatMessage, esbuildErrorText } from './css.js';

/** Marcador de "raíz de salida" que se sustituye por la ruta relativa real de cada archivo generado. */
export const MARK = '__VB_ROOT__';

let maxEsYear = null;
async function maxEsTarget() {
  if (maxEsYear) return maxEsYear;
  maxEsYear = 2020;
  for (let y = 2021; y <= 2035; y++) {
    try {
      await esbuild.transform('', { target: `es${y}` });
      maxEsYear = y;
    } catch {
      break;
    }
  }
  return maxEsYear;
}

/** Target de esbuild equivalente al nivel de sintaxis del código: ni transpila ni introduce sintaxis nueva. */
export async function targetForLevel(level, min = 0) {
  const l = level == null ? null : Math.max(level, min);
  if (l == null) return 'esnext';
  if (l === 5) return 'es5';
  return l > (await maxEsTarget()) ? 'esnext' : `es${l}`;
}

function esbuildSourcemap(cfg) {
  return cfg.sourcemap ? 'external' : false;
}

// esbuild quita en silencio los atributos de import (with { type }) con targets <= es2025.
const SUPPORTED = { 'import-attributes': true };

const firstLine = (err) => esbuildErrorText(err, '').split('\n')[0];

/**
 * Minifica (y opcionalmente ofusca) un script clásico sin alterar sus variables globales.
 * Si una transformación cambia las globales se prueba una más conservadora; en último caso se deja el original.
 */
export async function processClassic(ctx, { code, id, info, obfuscate, sourcemap = false }) {
  const js = ctx.cfg.js;
  const notes = [];
  let out = code;
  let map = null;
  if (js.minify) {
    const auto = await targetForLevel(info.level);
    const attempts = [{ target: js.target === 'auto' ? auto : js.target, keepNames: js.keepNames, label: 'completa' }];
    if (js.target !== 'auto' || js.keepNames) attempts.push({ target: auto, keepNames: false, label: 'sin transpilar' });
    attempts.push({ target: auto, keepNames: false, whitespace: true, label: 'solo espacios' });
    let done = false;
    for (const a of attempts) {
      try {
        const r = await esbuild.transform(code, {
          loader: 'js',
          target: a.target,
          charset: 'ascii',
          supported: SUPPORTED,
          legalComments: js.legalComments,
          drop: js.drop,
          define: js.define,
          keepNames: a.keepNames,
          sourcemap: sourcemap ? 'external' : false,
          sourcefile: id,
          ...(a.whitespace ? { minifyWhitespace: true } : { minify: true }),
          logLevel: 'silent',
        });
        const cmp = compareGlobals(info.top, r.code);
        if (cmp.ok) {
          out = r.code;
          map = r.map || null;
          done = true;
          break;
        }
        notes.push(`minificación ${a.label} descartada: ${cmp.reason}`);
      } catch (err) {
        notes.push(`minificación ${a.label} falló: ${firstLine(err)}`);
      }
    }
    if (!done) notes.push('se deja sin minificar para no romperlo');
  }
  if (obfuscate) {
    const o = obfuscateSafe(out, { isModule: false, options: ctx.obfuscatorOptions, id, globals: info.top });
    if (o.code) {
      out = o.code;
      map = null;
    } else notes.push(`no se ofuscó: ${o.reason}`);
  } else if (out !== code) {
    const t = await terserPass(ctx, out, { isModule: false, level: info.level, globals: info.top });
    if (t !== out) {
      out = t;
      map = null;
    }
  }
  return { code: out, map, notes };
}

/** Minifica un módulo ES sin empaquetar (sus import se quedan tal cual). */
export async function processModuleStandalone(ctx, { code, id, info, obfuscate, sourcemap = false }) {
  const js = ctx.cfg.js;
  const notes = [];
  let out = code;
  let map = null;
  if (js.minify) {
    try {
      const r = await esbuild.transform(code, {
        loader: 'js',
        format: 'esm',
        target: js.target === 'auto' ? await targetForLevel(info.level, 2015) : js.target,
        charset: 'ascii',
        supported: SUPPORTED,
        legalComments: js.legalComments,
        drop: js.drop,
        define: js.define,
        keepNames: js.keepNames,
        minify: true,
        sourcemap: sourcemap ? 'external' : false,
        sourcefile: id,
        logLevel: 'silent',
      });
      out = r.code;
      map = r.map || null;
    } catch (err) {
      notes.push(`no se pudo minificar: ${firstLine(err)}`);
    }
  }
  if (obfuscate) {
    const o = obfuscateSafe(out, { isModule: true, options: ctx.obfuscatorOptions, id });
    if (o.code) {
      out = o.code;
      map = null;
    } else notes.push(`no se ofuscó: ${o.reason}`);
  } else if (out !== code) {
    const t = await terserPass(ctx, out, { isModule: true, level: info.level });
    if (t !== out) {
      out = t;
      map = null;
    }
  }
  return { code: out, map, notes };
}

/** Ofusca un módulo ya generado (paquete, chunk o worker). */
export function obfuscateModule(ctx, code, id) {
  const o = obfuscateSafe(code, { isModule: true, options: ctx.obfuscatorOptions, id });
  return o.code ? { code: o.code } : { code, note: `no se ofuscó: ${o.reason}` };
}

/** Aplica un import map (solo "imports"; con "scopes" se usa el modo sin empaquetar). */
export function mapSpecifier(ctx, importMap, spec, importerDir) {
  if (!importMap?.imports) return null;
  const imports = importMap.imports;
  const isUrlLike = spec.startsWith('/') || spec.startsWith('./') || spec.startsWith('../');
  let target = null;
  if (!isUrlLike) {
    if (hasOwn(imports, spec)) target = imports[spec];
    else {
      const key = Object.keys(imports)
        .filter((k) => k.endsWith('/') && spec.startsWith(k))
        .sort((a, b) => b.length - a.length)[0];
      if (key) target = imports[key] + spec.slice(key.length);
    }
  } else {
    const wanted = path.posix.normalize(spec.startsWith('/') ? spec.slice(1) : path.posix.join(importerDir, spec));
    for (const [k, v] of Object.entries(imports)) {
      if (!(k.startsWith('/') || k.startsWith('./') || k.startsWith('../'))) continue;
      const kn = path.posix.normalize(k.startsWith('/') ? k.slice(1) : path.posix.join(importMap.baseDir, k));
      if (kn === wanted) target = v;
    }
  }
  if (target == null) return null;
  const c = classifyUrl(target);
  if (c.type === 'external') return { external: true };
  const r = ctx.resolve(target, importMap.baseDir);
  if (r.status === 'ok') return { rel: r.rel };
  // Paquetes de npm servidos desde node_modules: no se publican, pero existen en disco y se empaquetan.
  if ((r.status === 'missing' || r.status === 'ignored') && r.rel && /(^|\/)node_modules\//.test(r.rel)) {
    const abs = ctx.abs(r.rel);
    if (fs.existsSync(abs) && fs.statSync(abs).isFile()) return { abs };
  }
  return { broken: r, target };
}

const EXTERNAL_SPEC = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i;

function modulePlugin(ctx, group, state) {
  const isDepPath = (abs) => {
    if (!abs) return false;
    const rel = relFrom(ctx.root, abs);
    if (rel == null || /(^|\/)node_modules\//.test(toPosix(abs))) return true;
    return !!ctx.dependencyReason(rel);
  };
  const prepare = (code, id, baseDir, local) => {
    let info = state.analysis.get(id);
    if (!info) {
      info = analyzeJs(code, { module: true });
      state.analysis.set(id, info);
    }
    if (!info.ok) return code;
    state.levels.push(info.level ?? 9999);
    if (!local) return code;
    for (const u of info.unsafeUrls) state.unsafe.push(`new URL(variable, import.meta.url) en ${id}: ${u}`);
    for (const u of info.unsafeImports) state.unsafe.push(`import() con una ruta calculada en ${id}: ${u}`);
    if (state.mode === 'scan') ctx.noteJsInfo(id, info, baseDir, { module: true });
    if (!info.urls.length) return code;
    let out = '';
    let last = 0;
    for (const u of [...info.urls].sort((a, b) => a.start - b.start)) {
      const r = ctx.resolve(u.spec, baseDir);
      if (r.status !== 'ok') {
        if (state.mode === 'scan') ctx.reportBroken(id, u.spec, r);
        continue;
      }
      const target = ctx.urlTarget(r.rel, id);
      out += code.slice(last, u.start) + JSON.stringify(`${MARK}/${target}${r.info.suffix}`);
      last = u.end;
    }
    return out + code.slice(last);
  };
  return {
    name: 'vanilla-builder-js',
    setup(b) {
      b.onResolve({ filter: /^vb-inline:/ }, (a) => ({ path: a.path, namespace: 'vb-inline' }));
      b.onLoad({ filter: /.*/, namespace: 'vb-inline' }, (a) => {
        const v = group.virtual.get(a.path);
        return { contents: prepare(v.code, v.label, v.baseDir, true), resolveDir: ctx.abs(v.baseDir), loader: 'js' };
      });
      b.onResolve({ filter: /.*/ }, async (a) => {
        if (a.kind === 'entry-point') return undefined;
        const r = resolveSpecial(a);
        // Separación de dependencias: lo que el código propio importa de una librería va a su propio archivo vendor.
        if (!state.vendor || a.pluginData?.vbInner || r?.external || r?.errors) return r;
        if (a.namespace !== 'vb-inline' && isDepPath(a.importer)) return r;
        let abs = r?.path;
        if (!abs) {
          const res = await b.resolve(a.path, {
            kind: a.kind,
            resolveDir: a.resolveDir,
            importer: a.namespace === 'vb-inline' ? undefined : a.importer,
            pluginData: { vbInner: true },
          });
          if (res.errors.length || res.external) return undefined;
          abs = res.path;
        }
        if (!isDepPath(abs)) return r;
        if (state.mode === 'scan') {
          if (!state.vendor.has(abs)) state.vendor.set(abs, a.path);
          return r;
        }
        const out = state.vendorOut?.get(abs);
        return out ? { path: `${MARK}/${out}`, external: true } : r;
      });
      const resolveSpecial = (a) => {
        const spec = a.path;
        if (EXTERNAL_SPEC.test(spec)) return { path: spec, external: true };
        const importer = a.namespace === 'vb-inline' ? group.virtual.get(a.importer)?.label : relFrom(ctx.root, a.importer);
        const baseDir = relFrom(ctx.root, a.resolveDir) ?? '';
        if (a.with?.type === 'css') {
          // CSS module script: el navegador espera un CSSStyleSheet, así que el CSS va aparte.
          const r = ctx.resolve(spec, baseDir);
          if (r.status !== 'ok') {
            ctx.reportBroken(importer, spec, r);
            return { path: spec, external: true };
          }
          ctx.requireStandalone(r.rel, `importado como CSS desde ${importer}`);
          return { path: `${MARK}/${r.rel}`, external: true };
        }
        const mapped = mapSpecifier(ctx, group.importMap, spec, baseDir);
        if (mapped?.external) return { path: spec, external: true };
        if (mapped?.rel) return { path: ctx.abs(mapped.rel) };
        if (mapped?.abs) return { path: mapped.abs };
        if (mapped?.broken) return { errors: [{ text: `El import map de la página apunta "${spec}" a "${mapped.target}", que no existe.` }] };
        if (spec.startsWith('/')) {
          const r = ctx.resolve(spec, baseDir);
          if (r.status === 'ok') return { path: ctx.abs(r.rel) };
          return { errors: [{ text: `No existe "${spec}" (importado desde ${importer}).` }] };
        }
        return undefined;
      };
      b.onLoad({ filter: /\.(?:m?js|cjs)$/i }, (a) => {
        const rel = relFrom(ctx.root, a.path);
        const local = rel != null && !/(^|\/)node_modules\//.test(rel) && ctx.files.has(rel);
        const code = local ? ctx.readText(rel, { kind: 'js' }).text : fs.readFileSync(a.path, 'utf8');
        if (local) state.consumed.add(rel);
        return { contents: prepare(code, local ? rel : toPosix(a.path), local ? path.posix.dirname(rel) : '', local), loader: 'js' };
      });
    },
  };
}

function newState(mode, vendor = false) {
  return { mode, analysis: new Map(), levels: [], unsafe: [], consumed: new Set(), vendor: vendor ? new Map() : null, vendorOut: null };
}

let terser = null;

/** Carga terser (opcional) para la compresión máxima. */
export async function ensureTerser(projectRoot) {
  terser = await importOptional('terser', projectRoot, 'para la compresión máxima (js.minifier: "terser")');
}

/**
 * Segunda pasada con terser (varias pasadas de compresión). Solo se acepta si el resultado
 * es más pequeño y conserva globales (scripts) o exportaciones/importaciones (módulos).
 */
export async function terserPass(ctx, code, { isModule, level, globals }) {
  const js = ctx.cfg.js;
  if (!terser || js.minifier !== 'terser' || !js.minify || ctx.cfg.sourcemap) return code;
  const ecma = Math.min(2020, Math.max(5, level ?? 2020));
  let out;
  try {
    const r = await terser.minify(code, {
      module: isModule,
      toplevel: isModule,
      ecma,
      compress: { passes: 3, ecma, module: isModule, toplevel: isModule },
      mangle: { toplevel: isModule },
      keep_fnames: js.keepNames,
      keep_classnames: js.keepNames,
      format: { comments: /^!|@license|@preserve/i, ascii_only: true, ecma },
    });
    out = r.code;
  } catch {
    return code;
  }
  if (!out || out.length >= code.trimEnd().length) return code;
  if (isModule) {
    const a = moduleShape(code);
    const b = moduleShape(out);
    if (!a || !b || a.exports !== b.exports || a.imports !== b.imports) return code;
  } else if (!globals || !compareGlobals(globals, out).ok) return code;
  return out;
}

/** Bytes de origen que aportaron código a una salida (incluye paquetes de node_modules). */
function inputBytes(metafile, meta) {
  return Object.keys(meta.inputs ?? {}).reduce((sum, k) => sum + (metafile.inputs[k]?.bytes ?? 0), 0);
}

export function levelOf(target) {
  const m = /^es(\d{4})$/.exec(target);
  return m ? Number(m[1]) : target === 'es5' ? 5 : 2020;
}

/** Empaqueta las librerías importadas por el código propio en archivos vendor (sin ofuscar). */
async function buildVendor(ctx, group, common, vendor, target) {
  const chunkDir = ctx.cfg.js.chunkDir.replace(/\/+$/, '');
  const names = new Set();
  const entryPoints = [];
  for (const [abs, spec] of vendor) {
    const bare = !/^[./]/.test(spec) && !EXTERNAL_SPEC.test(spec);
    const base = (bare ? spec : path.basename(abs))
      .replace(/\.[cm]?js$/i, '')
      .replace(/^@/, '')
      .replace(/[^\w.-]+/g, '_');
    const name = names.has(base) ? `${base}-${shortHash(abs, 6)}` : base;
    names.add(name);
    entryPoints.push({ in: abs, out: `${chunkDir}/vendor/${name}` });
  }
  const st = newState('emit');
  const res = await esbuild.build({
    ...common,
    entryPoints,
    entryNames: group.hash ? '[dir]/[name]-[hash]' : '[dir]/[name]',
    chunkNames: `${chunkDir}/vendor/[name]-[hash]`,
    target,
    minify: ctx.cfg.js.minify,
    keepNames: ctx.cfg.js.keepNames,
    drop: ctx.cfg.js.drop,
    sourcemap: esbuildSourcemap(ctx.cfg),
    plugins: [modulePlugin(ctx, { importMap: group.importMap, virtual: new Map() }, st)],
  });
  const outdir = common.outdir;
  const outByAbs = new Map();
  const maps = new Map();
  const outputs = [];
  for (const f of res.outputFiles) {
    const outRel = toPosix(path.relative(outdir, f.path));
    if (outRel.endsWith('.map')) maps.set(outRel.slice(0, -4), f.text);
  }
  for (const f of res.outputFiles) {
    const outRel = toPosix(path.relative(outdir, f.path));
    if (outRel.endsWith('.map')) continue;
    const meta = res.metafile.outputs[toPosix(path.relative(ctx.root, f.path))] ?? {};
    if (meta.entryPoint) outByAbs.set(path.resolve(ctx.root, meta.entryPoint), outRel);
    let code = f.text.replace(/\n\/\/# sourceMappingURL=.*\n?$/, '\n');
    let map = maps.get(outRel) ?? null;
    ({ code, map } = finalizeMarkers(code, map, outRel));
    const srcInputs = Object.keys(meta.inputs ?? {})
      .map((p) => relFrom(ctx.root, path.resolve(ctx.root, p)))
      .filter((rel) => rel && ctx.files.has(rel));
    const before = inputBytes(res.metafile, meta);
    outputs.push({ outRel, code, map, entry: null, virtualId: null, inputs: srcInputs, isChunk: !meta.entryPoint, isVendor: true, before });
  }
  return { outByAbs, outputs, consumed: st.consumed };
}

/** Reescribe los import relativos de un módulo como si estuviera en `toFile` en lugar de `fromFile`. */
export function rebaseImports(code, fromFile, toFile) {
  const fromDir = path.posix.dirname(fromFile);
  const toDir = path.posix.dirname(toFile);
  if (fromDir === toDir) return code;
  const ast = acorn.parse(code, { ecmaVersion: 'latest', sourceType: 'module' });
  const spans = [];
  walk.full(ast, (n) => {
    const src =
      (n.type === 'ImportDeclaration' || n.type === 'ExportAllDeclaration' || n.type === 'ExportNamedDeclaration' || n.type === 'ImportExpression') &&
      n.source;
    if (src && src.type === 'Literal' && typeof src.value === 'string' && /^\.\.?\//.test(src.value)) spans.push(src);
  });
  let out = code;
  for (const s of spans.sort((a, b) => b.start - a.start)) {
    const target = path.posix.normalize(path.posix.join(fromDir, s.value));
    let rel = path.posix.relative(toDir, target);
    if (!rel.startsWith('.')) rel = `./${rel}`;
    out = out.slice(0, s.start) + JSON.stringify(rel) + out.slice(s.end);
  }
  return out;
}

/** Sustituye el marcador de raíz por la ruta relativa real (manteniendo el source map alineado). */
export function finalizeMarkers(code, map, outRel) {
  return replaceWithMap(code, map, `${MARK}/`, `${rootPrefix(outRel)}/`);
}

/**
 * Empaqueta un grupo de módulos (todas las páginas que comparten import map).
 * @returns {Promise<{mode:'bundle'|'per-file', reason?: string, outputs?: Array, consumed: Set<string>, inputs: string[]}>}
 */
export async function buildModuleGroup(ctx, group) {
  const cfg = ctx.cfg;
  const entryPoints = [...[...group.entries].map((rel) => ctx.abs(rel)), ...[...group.virtual.entries()].map(([id, v]) => ({ in: id, out: v.out }))];
  const outdir = path.join(ctx.root, '__vb_out__');
  const chunkDir = cfg.js.chunkDir.replace(/\/+$/, '');
  const common = {
    absWorkingDir: ctx.root,
    entryPoints,
    bundle: true,
    splitting: true,
    format: 'esm',
    platform: 'browser',
    outdir,
    outbase: ctx.root,
    entryNames: group.hash ? `${chunkDir}/[name]-[hash]` : '[dir]/[name]',
    chunkNames: `${chunkDir}/[name]-[hash]`,
    assetNames: `${chunkDir}/[name]-[hash]`,
    write: false,
    metafile: true,
    charset: 'ascii',
    supported: SUPPORTED,
    logLevel: 'silent',
    legalComments: cfg.js.legalComments,
    define: cfg.js.define,
  };
  const scanState = newState('scan', group.vendorSplit);
  let scan;
  try {
    scan = await esbuild.build({ ...common, target: 'esnext', plugins: [modulePlugin(ctx, group, scanState)] });
  } catch (err) {
    throw new BuildError('No se pudieron empaquetar los módulos JavaScript:', esbuildErrorText(err, ctx.root).split('\n'));
  }
  const inputs = Object.keys(scan.metafile.inputs)
    .map((p) => relFrom(ctx.root, path.resolve(ctx.root, p)))
    .filter((rel) => rel && ctx.files.has(rel));
  const dynamicWarnings = scan.warnings.filter((w) => w.id === 'unsupported-dynamic-import');
  let reason = null;
  if (!cfg.js.bundle) reason = 'js.bundle está desactivado';
  else if (group.forcePerFile) reason = group.forcePerFile;
  else if (dynamicWarnings.length) reason = `hay import() con rutas que no se pueden seguir (${formatMessage(dynamicWarnings[0], ctx.root)})`;
  else if (scanState.unsafe.length) reason = scanState.unsafe[0];
  if (reason) return { mode: 'per-file', reason, inputs, consumed: new Set() };
  for (const w of scan.warnings) ctx.warn(`JS: ${formatMessage(w, ctx.root)}`);

  const target = cfg.js.target === 'auto' ? await targetForLevel(Math.max(2015, ...scanState.levels)) : cfg.js.target;
  const emitState = newState('emit', group.vendorSplit);
  emitState.analysis = scanState.analysis;
  let vendor = null;
  if (scanState.vendor?.size) {
    try {
      vendor = await buildVendor(ctx, group, common, scanState.vendor, target);
      emitState.vendorOut = vendor.outByAbs;
    } catch (err) {
      ctx.warn(
        `no se pudieron separar las dependencias en archivos vendor (${esbuildErrorText(err, ctx.root).split('\n')[0]}); van dentro del paquete y se ofuscarán con él`,
      );
    }
  }
  let res;
  try {
    res = await esbuild.build({
      ...common,
      target,
      minify: cfg.js.minify,
      keepNames: cfg.js.keepNames,
      drop: cfg.js.drop,
      sourcemap: esbuildSourcemap(cfg),
      plugins: [modulePlugin(ctx, group, emitState)],
    });
  } catch (err) {
    throw new BuildError('No se pudieron empaquetar los módulos JavaScript:', esbuildErrorText(err, ctx.root).split('\n'));
  }
  const maps = new Map();
  const files = [];
  for (const f of res.outputFiles) {
    const outRel = toPosix(path.relative(outdir, f.path));
    if (outRel.endsWith('.map')) maps.set(outRel.slice(0, -4), f.text);
    else files.push({ outRel, text: f.text, key: toPosix(path.relative(ctx.root, f.path)) });
  }
  const outputs = [];
  for (const f of files) {
    const meta = res.metafile.outputs[f.key] ?? {};
    const srcInputs = Object.keys(meta.inputs ?? {})
      .map((p) => relFrom(ctx.root, path.resolve(ctx.root, p)))
      .filter((rel) => rel && ctx.files.has(rel));
    // Los módulos inline se reconocen por su entrada ("vb-inline:..."), no por la ruta: esbuild puede moverlos.
    const ep = meta.entryPoint ?? '';
    const virtualId = [ep, ep.replace(/^vb-inline:/, '')].find((k) => group.virtual.has(k)) ?? null;
    const entry = ep && !virtualId ? relFrom(ctx.root, path.resolve(ctx.root, ep)) : null;
    let code = f.text.replace(/\n\/\/# sourceMappingURL=.*\n?$/, '\n');
    let map = maps.get(f.outRel) ?? null;
    if (virtualId) {
      // El código irá dentro del HTML: sus rutas relativas deben partir de la página, no de donde lo dejó esbuild.
      const v = group.virtual.get(virtualId);
      const pageFile = `${v.baseDir ? `${v.baseDir}/` : ''}__page.html`;
      ({ code } = finalizeMarkers(code, null, pageFile));
      code = rebaseImports(code, f.outRel, pageFile);
      map = null;
    } else ({ code, map } = finalizeMarkers(code, map, f.outRel));
    outputs.push({ outRel: f.outRel, code, map, entry, virtualId, inputs: srcInputs, isChunk: !ep, before: inputBytes(res.metafile, meta) });
  }
  if (vendor) {
    outputs.push(...vendor.outputs);
    for (const rel of vendor.consumed) emitState.consumed.add(rel);
  }
  return { mode: 'bundle', outputs, consumed: emitState.consumed, inputs, target, vendor: vendor ? [...scanState.vendor.values()] : [] };
}

/** Worker o service worker de tipo módulo: se empaqueta solo, sin compartir chunks, en su ruta original. */
export async function buildModuleWorker(ctx, rel) {
  const group = { importMap: null, virtual: new Map(), entries: new Set([rel]) };
  const state = newState('scan');
  const outfile = path.join(ctx.root, '__vb_out__', rel);
  const run = (st, extra) =>
    esbuild.build({
      absWorkingDir: ctx.root,
      entryPoints: [ctx.abs(rel)],
      bundle: true,
      format: 'esm',
      platform: 'browser',
      outfile,
      write: false,
      metafile: true,
      charset: 'ascii',
      supported: SUPPORTED,
      logLevel: 'silent',
      legalComments: ctx.cfg.js.legalComments,
      define: ctx.cfg.js.define,
      plugins: [modulePlugin(ctx, group, st)],
      ...extra,
    });
  try {
    await run(state, { target: 'esnext' });
    const emit = newState('emit');
    emit.analysis = state.analysis;
    const js = ctx.cfg.js;
    const target = js.target === 'auto' ? await targetForLevel(Math.max(2015, ...state.levels)) : js.target;
    const res = await run(emit, { target, minify: js.minify, keepNames: js.keepNames, drop: js.drop, sourcemap: esbuildSourcemap(ctx.cfg) });
    let code = '';
    let map = null;
    for (const f of res.outputFiles) {
      if (f.path.endsWith('.map')) map = f.text;
      else code = f.text.replace(/\n\/\/# sourceMappingURL=.*\n?$/, '\n');
    }
    ({ code, map } = finalizeMarkers(code, map, rel));
    return { code, map, consumed: emit.consumed };
  } catch (err) {
    return { error: esbuildErrorText(err, ctx.root) };
  }
}
