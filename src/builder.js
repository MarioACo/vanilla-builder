// Orquestador: descubre dependencias, procesa cada tipo de archivo, verifica y publica la salida.
import fs from 'node:fs';
import path from 'node:path';
import { scanProject, matchFiles, globMatcher } from './files.js';
import { resolveRef, classifyUrl, parseSrcset } from './urls.js';
import { analyzeJs } from './jsinfo.js';
import { parseHtml, adjacentSiblings, applyEdits, attrText, escapeInlineScript, escapeInlineStyle, minifyHtml, detectPreWhitespace } from './html.js';
import { buildCss, minifyStyleAttr } from './css.js';
import { processClassic, processModuleStandalone, buildModuleGroup, buildModuleWorker, obfuscateModule } from './js.js';
import { resolveObfuscatorOptions } from './obfuscate.js';
import { assertSafeOutDir, writeStaging, swapIntoPlace, discardStaging, writeManifest, MANIFEST } from './output.js';
import { verifyOutput } from './verify.js';
import { buildReport } from './report.js';
import {
  BuildError,
  decodeUtf8,
  stripBom,
  BOM,
  extOf,
  JS_EXT,
  CSS_EXT,
  HTML_EXT,
  shortHash,
  sri,
  encodePath,
  minifyJsonText,
} from './util.js';

export const VERSION = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

const MERGE_ATTRS = new Set(['src', 'type', 'defer', 'charset', 'language']);
const typeOfExt = (ext) =>
  HTML_EXT.has(ext) ? 'html' : JS_EXT.has(ext) ? 'js' : CSS_EXT.has(ext) ? 'css' : ext === '.json' || ext === '.webmanifest' ? 'json' : ext === '.svg' ? 'svg' : ['.txt', '.xml', '.md', '.csv'].includes(ext) ? 'text' : 'asset';

class Context {
  constructor(cfg, opts) {
    this.cfg = cfg;
    this.opts = opts;
    this.root = cfg.root;
    const { files, ignored } = scanProject(cfg);
    this.files = files;
    this.ignored = ignored;
    this.ignoredSet = new Set(ignored.map((i) => i.rel));
    this.lowerMap = new Map([...files.keys()].map((k) => [k.toLowerCase(), k]));
    this.base = cfg.base;
    this.warnings = [];
    this.notes = [];
    this.broken = [];
    this.brokenKeys = new Set();
    this.brokenValues = new Set();
    this.assets = new Map();
    this.standalone = new Map();
    this.workers = new Map();
    this.mentions = new Map();
    this.coverage = new Map();
    this.outputs = new Map();
    this.outLower = new Map();
    this.textCache = new Map();
    this.infoCache = new Map();
    this.pageDirs = new Set(['']);
    this.pageRefs = new Set();
    this.done = new Set();
    this.obfuscatorOptions = opts.mode === 'analyze' ? null : resolveObfuscatorOptions(cfg.obfuscate);
    this.obfExcluded = globMatcher(cfg.obfuscateExclude);
    this.chunkDir = cfg.js.chunkDir.replace(/\/+$/, '');
  }

  abs(rel) {
    return path.join(this.root, rel);
  }

  resolve(spec, baseDir, opts) {
    return resolveRef(spec, baseDir, this, opts);
  }

  /** Intenta resolver una ruta escrita como texto contra varias carpetas posibles. */
  resolveLoose(spec, dirs) {
    const c = classifyUrl(spec);
    if (c.type !== 'root' && c.type !== 'relative') return null;
    for (const d of dirs) {
      const r = this.resolve(spec, d);
      if (r.status === 'ok') return r.rel;
    }
    return null;
  }

  warn(msg, file) {
    const text = file ? `${file}: ${msg}` : msg;
    if (!this.warnings.includes(text)) this.warnings.push(text);
  }

  note(msg, file) {
    const text = file ? `${file}: ${msg}` : msg;
    if (!this.notes.includes(text)) this.notes.push(text);
  }

  readText(rel, { kind = 'text', charset } = {}) {
    const key = `${rel}\0${kind}`;
    if (this.textCache.has(key)) return this.textCache.get(key);
    const buf = fs.readFileSync(this.abs(rel));
    let text = decodeUtf8(buf);
    let encoding = 'utf8';
    if (text == null) {
      if (kind === 'html') {
        // latin1 conserva cada byte tal cual: lo que no se edita sale idéntico.
        text = buf.toString('latin1');
        encoding = 'latin1';
        this.warn('no es UTF-8; se conserva su codificación original y no se minifica', rel);
      } else {
        let label = (charset || 'windows-1252').toLowerCase();
        try {
          text = new TextDecoder(label).decode(buf);
        } catch {
          label = 'windows-1252';
          text = new TextDecoder(label).decode(buf);
        }
        encoding = label;
        this.note(`no es UTF-8; se leyó como ${label} y la salida usa escapes ASCII (no depende de la codificación)`, rel);
      }
    }
    const stripped = stripBom(text);
    const res = { text: stripped.text, bom: stripped.bom, encoding };
    this.textCache.set(key, res);
    return res;
  }

  jsInfo(rel, module = 'auto') {
    const key = `${rel}\0${module}`;
    if (!this.infoCache.has(key)) this.infoCache.set(key, analyzeJs(this.readText(rel, { kind: 'js' }).text, { module }));
    return this.infoCache.get(key);
  }

  reportBroken(from, url, r) {
    const key = `${from}\0${url}`;
    this.brokenValues.add(url);
    if (this.brokenKeys.has(key)) return;
    this.brokenKeys.add(key);
    this.broken.push({ from, url, status: r.status, target: r.rel });
    if (r.status === 'ignored') this.warn(`referencia a "${url}", pero ese archivo está excluido (ignore). No se publicará.`, from);
    else if (r.status === 'case') this.warn(`"${url}" solo existe como "${r.rel}" (otras mayúsculas): en un servidor Linux daría 404.`, from);
    else if (r.status === 'missing') this.warn(`"${url}" no existe (ya estaba rota en el código fuente).`, from);
    else if (r.status === 'outside') this.note(`"${url}" apunta fuera del proyecto; se deja igual.`, from);
  }

  registerAsset(rel, from) {
    if (!this.assets.has(rel)) this.assets.set(rel, new Set());
    if (from) this.assets.get(rel).add(from);
    const ext = extOf(rel);
    if (JS_EXT.has(ext) || CSS_EXT.has(ext)) this.requireStandalone(rel, `referenciado desde ${from}`);
  }

  assetOut(rel) {
    return rel;
  }

  /** Destino de new URL('...', import.meta.url): siempre la ruta original del archivo. */
  urlTarget(rel, from) {
    const ext = extOf(rel);
    if (JS_EXT.has(ext) || CSS_EXT.has(ext)) {
      if (!this.workers.has(rel)) this.requireStandalone(rel, `new URL() en ${from}`);
    } else this.registerAsset(rel, from);
    return rel;
  }

  requireStandalone(rel, reason, extra = {}) {
    if (!this.standalone.has(rel)) this.standalone.set(rel, { reason, ...extra });
    else if (extra.module) this.standalone.get(rel).module = true;
  }

  registerWorker(rel, info) {
    const prev = this.workers.get(rel);
    if (prev) {
      if (prev.module !== info.module) this.warn(`se usa como worker clásico y de módulo a la vez; se trata como módulo`, rel);
      prev.module = prev.module || info.module;
      return;
    }
    this.workers.set(rel, info);
  }

  /** Registra workers, service workers, importScripts y rutas mencionadas como texto. */
  noteJsInfo(id, info, baseDir) {
    for (const w of info.workers) {
      if (!w.spec) {
        this.warn(`${w.kind} con una ruta que no es texto fijo; Builder no puede seguirla (el archivo se procesará suelto si existe).`, id);
        continue;
      }
      const c = classifyUrl(w.spec);
      if (c.type !== 'root' && c.type !== 'relative') continue;
      const dirs = w.viaUrl || w.kind === 'importScripts' ? [baseDir] : [baseDir, ...this.pageDirs];
      const rel = this.resolveLoose(w.spec, dirs);
      if (!rel) {
        this.reportBroken(id, w.spec, this.resolve(w.spec, baseDir));
        continue;
      }
      if (w.kind === 'importScripts') this.requireStandalone(rel, `importScripts en ${id}`, { classic: true });
      else this.registerWorker(rel, { module: w.module, kind: w.kind, from: id });
    }
    for (const s of info.strings) {
      const rel = this.resolveLoose(s, [baseDir, ...this.pageDirs]);
      if (rel && !this.mentions.has(rel)) this.mentions.set(rel, id);
    }
  }

  cover(rel, status, out) {
    if (!this.files.has(rel)) return;
    if (!this.coverage.has(rel)) this.coverage.set(rel, []);
    this.coverage.get(rel).push(out ? `${status} → ${out}` : status);
  }

  hasOwnOutput(rel) {
    const o = this.outputs.get(rel);
    return !!o && o.sources?.includes(rel);
  }

  shouldObfuscate(rels) {
    if (!this.obfuscatorOptions) return false;
    const list = rels.filter(Boolean);
    return list.length > 0 && !list.every((r) => this.obfExcluded(r));
  }

  /** Registra un archivo de salida; nunca sobrescribe en silencio un contenido distinto. */
  emit(outRel, data, meta) {
    const norm = path.posix.normalize(outRel);
    if (norm.startsWith('../') || path.posix.isAbsolute(norm) || norm === MANIFEST) throw new BuildError(`Ruta de salida inválida: ${outRel}`);
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data, meta.encoding === 'latin1' ? 'latin1' : 'utf8');
    const prev = this.outputs.get(norm);
    if (prev) {
      const same = prev.copyFrom ? fs.readFileSync(prev.copyFrom).equals(buf) : prev.data.equals(buf);
      if (!same)
        throw new BuildError(`Dos resultados distintos quieren escribirse en "${norm}".`, [
          `Primero: ${(prev.sources ?? []).join(', ') || prev.action}`,
          `Después: ${(meta.sources ?? []).join(', ') || meta.action}`,
          'Suele pasar si el mismo archivo se usa con import maps distintos o si una carpeta del proyecto se llama igual que js.chunkDir.',
        ]);
      prev.sources = [...new Set([...(prev.sources ?? []), ...(meta.sources ?? [])])];
      return norm;
    }
    const lower = norm.toLowerCase();
    if (this.outLower.has(lower) && this.outLower.get(lower) !== norm)
      this.warn(`"${norm}" y "${this.outLower.get(lower)}" solo se diferencian en mayúsculas; en Windows/macOS se pisarían.`);
    this.outLower.set(lower, norm);
    this.outputs.set(norm, { ...meta, data: buf });
    return norm;
  }

  emitCopy(outRel, rel, action = 'copy') {
    const f = this.files.get(rel);
    const prev = this.outputs.get(outRel);
    if (prev) {
      if (prev.sources?.includes(rel)) return outRel;
      return this.emit(outRel, fs.readFileSync(f.abs), { type: typeOfExt(f.ext), action, sources: [rel] });
    }
    this.outputs.set(outRel, { copyFrom: f.abs, size: f.size, type: typeOfExt(f.ext), action, sources: [rel] });
    this.outLower.set(outRel.toLowerCase(), outRel);
    return outRel;
  }

  /** Añade el source map según la configuración y registra el archivo. */
  emitCode(outRel, code, map, meta) {
    const sm = this.cfg.sourcemap;
    let text = code;
    if (map && sm) {
      const isCss = meta.type === 'css';
      if (sm === 'inline') {
        const url = `data:application/json;base64,${Buffer.from(map).toString('base64')}`;
        text += isCss ? `\n/*# sourceMappingURL=${url} */\n` : `\n//# sourceMappingURL=${url}\n`;
      } else {
        this.emit(`${outRel}.map`, map, { type: 'map', action: 'sourcemap', sources: meta.sources });
        if (sm !== 'hidden') {
          const name = path.posix.basename(outRel);
          text += isCss ? `\n/*# sourceMappingURL=${name}.map */\n` : `\n//# sourceMappingURL=${name}.map\n`;
        }
      }
    }
    return this.emit(outRel, text, meta);
  }

  hashedPath(rel, data, ext) {
    const name = path.posix.basename(rel, path.posix.extname(rel));
    return `${this.chunkDir}/${name}-${shortHash(data)}${ext}`;
  }

  outputBytes(outRel) {
    const o = this.outputs.get(outRel);
    return o.copyFrom ? fs.readFileSync(o.copyFrom) : o.data;
  }
}

/** URL para escribir en el HTML, respetando si el original era absoluto (/x) o relativo. */
function urlFor(ctx, page, originalValue, targetRel) {
  const info = classifyUrl(originalValue);
  const suffix = info.suffix ?? '';
  if (info.type === 'root') return `${ctx.base}${encodePath(targetRel)}${suffix}`;
  let rel = path.posix.relative(page.baseDir || '.', targetRel);
  if (!rel) rel = path.posix.basename(targetRel);
  return encodePath(rel) + suffix;
}

/** Lee y analiza todos los HTML del proyecto. */
function loadPages(ctx) {
  const pages = new Map();
  for (const [rel, f] of ctx.files) {
    if (!HTML_EXT.has(f.ext)) continue;
    const { text, bom, encoding } = ctx.readText(rel, { kind: 'html' });
    let model;
    try {
      model = parseHtml(text);
    } catch (err) {
      ctx.warn(`no se pudo analizar el HTML (${err.message}); se copia tal cual`, rel);
      continue;
    }
    const dir = path.posix.dirname(rel) === '.' ? '' : path.posix.dirname(rel);
    const page = { rel, text, bom, encoding, model, dir, baseDir: dir, baseExternal: false, full: false, edits: [] };
    if (model.base != null) {
      const c = classifyUrl(model.base);
      if (c.type === 'external') {
        page.baseExternal = true;
        ctx.warn(`<base href="${model.base}"> apunta fuera del sitio; sus rutas relativas no se pueden comprobar y se dejan igual.`, rel);
      } else if (c.type === 'root' || c.type === 'relative') {
        const p = c.type === 'root' ? (c.path.startsWith(ctx.base) ? c.path.slice(ctx.base.length) : c.path.slice(1)) : path.posix.join(dir, c.path);
        page.baseDir = path.posix.normalize(p.endsWith('/') ? p : path.posix.dirname(p)).replace(/^\.$/, '').replace(/\/$/, '');
      }
    }
    pages.set(rel, page);
  }
  return pages;
}

/** Decide qué páginas se procesan completas (entradas + enlazadas) y cuáles en modo conservador. */
function selectEntries(ctx, pages) {
  const cfg = ctx.cfg;
  const extraEntries = { modules: [], classic: [], css: [] };
  let queue = [];
  if (cfg.entries === 'auto') {
    queue = [...pages.values()].filter((p) => p.model.isDocument).map((p) => p.rel);
  } else {
    const { matched, missing } = matchFiles(ctx.files, cfg.entries);
    if (missing.length) throw new BuildError('Algunas entradas de "entries" no existen:', missing);
    for (const rel of matched) {
      const ext = extOf(rel);
      if (HTML_EXT.has(ext)) queue.push(rel);
      else if (CSS_EXT.has(ext)) extraEntries.css.push(rel);
      else if (JS_EXT.has(ext)) {
        const info = ctx.jsInfo(rel);
        (info.ok && (info.hasModuleSyntax || info.hasImportMeta) ? extraEntries.modules : extraEntries.classic).push(rel);
      } else ctx.warn(`"${rel}" no es HTML, JS ni CSS; se copiará como recurso`, 'entries');
    }
  }
  const full = new Set();
  while (queue.length) {
    const rel = queue.shift();
    const page = pages.get(rel);
    if (!page || full.has(rel)) continue;
    if (page.encoding === 'latin1' || page.baseExternal) {
      continue; // se procesa en modo conservador
    }
    full.add(rel);
    page.full = true;
    ctx.pageDirs.add(page.baseDir);
    for (const r of page.model.refs) {
      if (r.kind !== 'page') continue;
      const res = ctx.resolve(r.value, page.baseDir, { page: true });
      if (res.status === 'ok' && HTML_EXT.has(extOf(res.rel)) && pages.get(res.rel)?.model.isDocument) queue.push(res.rel);
    }
  }
  return extraEntries;
}

/** Registra los recursos simples (imágenes, iconos, enlaces...) de una página. */
function collectRefs(ctx, page) {
  for (const r of page.model.refs) {
    const values = r.kind === 'srcset' ? parseSrcset(r.value).map((c) => c.url) : [r.value];
    for (const v of values) {
      const res = ctx.resolve(v, page.baseDir, { page: r.kind === 'page' });
      if (res.status === 'skip') continue;
      if (res.status !== 'ok') {
        if (r.soft) ctx.brokenValues.add(v);
        else ctx.reportBroken(page.rel, v, res);
        continue;
      }
      if (HTML_EXT.has(extOf(res.rel))) {
        ctx.pageRefs.add(res.rel);
        continue;
      }
      ctx.registerAsset(res.rel, page.rel);
    }
  }
  for (const l of page.model.links) {
    if (l.type === 'stylesheet' || l.type === 'preload') continue;
    const res = ctx.resolve(l.href.value, page.baseDir, { page: l.type === 'page' });
    if (res.status === 'ok') {
      if (!HTML_EXT.has(extOf(res.rel))) ctx.registerAsset(res.rel, page.rel);
    } else if (res.status !== 'skip') {
      if (l.type === 'asset') ctx.reportBroken(page.rel, l.href.value, res);
      else ctx.brokenValues.add(l.href.value);
    }
  }
}

function parseImportMap(ctx, page, item) {
  try {
    const json = JSON.parse(item.inline.code);
    return { json, imports: json.imports ?? {}, scopes: json.scopes, baseDir: page.baseDir };
  } catch (err) {
    ctx.warn(`el import map no es JSON válido (${err.message}); se ignora`, page.rel);
    return null;
  }
}

/** Agrupa los scripts clásicos consecutivos que se pueden unir sin cambiar el comportamiento. */
function classicRuns(ctx, page) {
  const cfg = ctx.cfg;
  const mergeOn = cfg.js.mergeClassic === 'auto' ? !cfg.sourcemap : cfg.js.mergeClassic;
  const runs = [];
  let current = null;
  const close = () => {
    if (current) runs.push(current);
    current = null;
  };
  for (const s of page.model.scripts) {
    if (s.kind !== 'classic' || !s.src) {
      close();
      continue;
    }
    const res = ctx.resolve(s.src.value, page.baseDir);
    if (res.status === 'skip') {
      close();
      continue;
    }
    if (res.status !== 'ok') {
      ctx.reportBroken(page.rel, s.src.value, res);
      close();
      continue;
    }
    const rel = res.rel;
    if (!JS_EXT.has(extOf(rel))) ctx.note(`<script src> apunta a "${rel}" (extensión no habitual); se trata como JavaScript`, page.rel);
    const info = ctx.jsInfo(rel, false);
    const attrs = s.attrs;
    const reasons = [];
    if (!mergeOn) reasons.push('unión desactivada');
    if (!info.ok) reasons.push('no se pudo analizar');
    if (s.inTemplate) reasons.push('dentro de <template>');
    if (attrs.has('async')) reasons.push('async');
    if (info.usesCurrentScript) reasons.push('usa document.currentScript');
    if (info.usesDocumentWrite) reasons.push('usa document.write');
    const extra = [...attrs.keys()].filter((a) => !MERGE_ATTRS.has(a));
    if (extra.length) reasons.push(`atributos ${extra.join(', ')}`);
    const obf = ctx.shouldObfuscate([rel]);
    const key = [attrs.has('defer'), attrs.has('nomodule'), attrs.get('charset') ?? '', info.strict, obf].join('|');
    const cand = { s, rel, info, key, obf, reasons };
    if (reasons.length) {
      close();
      runs.push({ items: [cand], names: null });
      continue;
    }
    if (current && current.key === key && adjacentSiblings(current.items.at(-1).s, s) && !conflicts(current.names, info.top)) {
      current.items.push(cand);
      for (const [n, k] of info.top) if (!current.names.has(n) || k === 'lex') current.names.set(n, k);
    } else {
      close();
      current = { key, items: [cand], names: new Map(info.top) };
    }
  }
  close();
  return runs;
}

function conflicts(names, top) {
  for (const [n, k] of top) if (names.has(n) && (k === 'lex' || names.get(n) === 'lex')) return true;
  return false;
}

function setIntegrity(ctx, page, item, attrName, bytes) {
  const has = item.attrs.has('integrity');
  const loc = item.el.sourceCodeLocation.attrs?.integrity;
  const mode = ctx.cfg.sri;
  if (has && loc) {
    if (mode === false) page.edits.push({ start: loc.startOffset, end: loc.endOffset, text: '' });
    else page.edits.push({ start: loc.startOffset, end: loc.endOffset, text: attrText('integrity', sri(bytes)) });
  } else if (mode === true) {
    const at = item.el.sourceCodeLocation.attrs?.[attrName];
    if (at) page.edits.push({ start: at.endOffset, end: at.endOffset, text: ` ${attrText('integrity', sri(bytes))}` });
  }
}

/** Ejecuta todo el proceso. mode: 'build' escribe la salida; 'analyze' solo calcula el plan. */
export async function runPipeline(cfg, opts = {}) {
  const mode = opts.mode ?? 'build';
  const t0 = Date.now();
  if (mode === 'build') assertSafeOutDir(cfg, { force: opts.force });
  const ctx = new Context(cfg, { ...opts, mode });
  const log = opts.log ?? (() => {});

  // 1. Páginas y entradas
  const pages = loadPages(ctx);
  const extra = selectEntries(ctx, pages);
  const fullPages = [...pages.values()].filter((p) => p.full);
  const partialPages = [...pages.values()].filter((p) => !p.full);
  log(`Páginas: ${fullPages.length} completas, ${partialPages.length} en modo conservador`);
  const htmlBlob = [];
  for (const p of fullPages) collectRefs(ctx, p);
  for (const p of partialPages) collectRefs(ctx, p);

  // 2. Módulos ES agrupados por import map
  const groups = new Map();
  const groupFor = (page, importMap) => {
    const key = importMap ? `${page.baseDir}\0${JSON.stringify(importMap.json)}` : '';
    if (!groups.has(key))
      groups.set(key, {
        key,
        importMap,
        hash: cfg.hash,
        entries: new Set(),
        virtual: new Map(),
        pages: new Set(),
        forcePerFile: importMap?.scopes ? 'el import map usa "scopes"' : null,
      });
    return groups.get(key);
  };
  const moduleRefs = [];
  const preloadLinks = [];
  for (const page of fullPages) {
    const map = page.model.importMaps[0] ? parseImportMap(ctx, page, page.model.importMaps[0]) : null;
    if (page.model.importMaps.length > 1) ctx.warn('tiene varios import maps; solo se usa el primero para empaquetar', page.rel);
    let vIndex = 0;
    for (const s of page.model.scripts) {
      if (s.kind !== 'module' || s.inTemplate) continue;
      const g = groupFor(page, map);
      g.pages.add(page.rel);
      if (s.src) {
        const res = ctx.resolve(s.src.value, page.baseDir);
        if (res.status === 'skip') continue;
        if (res.status !== 'ok') {
          ctx.reportBroken(page.rel, s.src.value, res);
          continue;
        }
        g.entries.add(res.rel);
        moduleRefs.push({ page, s, rel: res.rel, group: g });
      } else if (s.inline && s.inline.code.trim()) {
        const id = `vb-inline:${page.rel}#${vIndex++}`;
        const outDir = page.baseDir ? `${page.baseDir}/` : '';
        g.virtual.set(id, { code: s.inline.code, label: `${page.rel} (módulo inline ${vIndex})`, baseDir: page.baseDir, out: `${outDir}__vb_inline_${shortHash(id)}`, page, s });
      }
    }
    for (const l of page.model.links) if (l.type === 'preload') preloadLinks.push({ page, l });
  }
  if (extra.modules.length) {
    const g = { key: '\0entries', importMap: null, hash: false, entries: new Set(extra.modules), virtual: new Map(), pages: new Set(), forcePerFile: null };
    groups.set(g.key, g);
  }
  const entryOut = new Map(); // `${groupKey}\0${rel}` → outRel
  const inlineModuleCode = new Map(); // virtual id → código final
  for (const g of groups.values()) {
    if (!g.entries.size && !g.virtual.size) continue;
    const res = await buildModuleGroup(ctx, { ...g, hash: g.hash });
    if (res.mode === 'per-file') {
      ctx.note(`módulos sin empaquetar (cada archivo minificado en su sitio): ${res.reason}`, [...g.pages].join(', ') || 'entries');
      for (const rel of res.inputs) ctx.requireStandalone(rel, 'módulo (modo sin empaquetar)', { module: true });
      for (const rel of g.entries) entryOut.set(`${g.key}\0${rel}`, rel);
      for (const [id, v] of g.virtual) {
        const info = analyzeJs(v.code, { module: true });
        if (!info.ok) continue;
        ctx.noteJsInfo(v.label, info, v.baseDir);
        for (const imp of info.imports) if (imp.spec) markModuleImport(ctx, imp.spec, v.baseDir, v.label, g.importMap);
        const r = await processModuleStandalone(ctx, { code: v.code, id: v.label, info, obfuscate: ctx.shouldObfuscate([v.page.rel]) });
        for (const n of r.notes) ctx.note(n, v.label);
        inlineModuleCode.set(id, r.code);
      }
      continue;
    }
    log(`Módulos: ${g.entries.size} entradas, ${res.inputs.length} archivos, target ${res.target}`);
    for (const o of res.outputs) {
      const sources = o.inputs.length ? o.inputs : o.entry ? [o.entry] : [];
      let code = o.code;
      let map = o.map;
      const obfRels = o.virtualId ? [g.virtual.get(o.virtualId).page.rel] : o.isChunk ? o.inputs : [o.entry];
      if (ctx.shouldObfuscate(obfRels)) {
        const r = obfuscateModule(ctx, code, o.outRel);
        if (r.note) ctx.warn(r.note, o.outRel);
        else {
          code = r.code;
          map = null;
        }
      }
      if (o.virtualId) {
        const v = g.virtual.get(o.virtualId);
        inlineModuleCode.set(o.virtualId, code.replace(/\n$/, ''));
        for (const rel of o.inputs) ctx.cover(rel, 'empaquetado', `${v.page.rel} (módulo inline)`);
        continue;
      }
      const outRel = ctx.emitCode(o.outRel, code, map, { type: 'js', module: true, action: o.isChunk ? 'chunk' : 'bundle', sources, before: sumSizes(ctx, sources) });
      if (o.entry) entryOut.set(`${g.key}\0${o.entry}`, outRel);
      for (const rel of o.inputs) ctx.cover(rel, 'empaquetado', outRel);
    }
  }

  // 3. CSS enlazado
  const cssOut = new Map();
  const cssEntries = new Set(extra.css);
  for (const page of fullPages) for (const l of page.model.links) if (l.type === 'stylesheet') {
    const res = ctx.resolve(l.href.value, page.baseDir);
    if (res.status === 'ok') cssEntries.add(res.rel);
    else if (res.status !== 'skip') ctx.reportBroken(page.rel, l.href.value, res);
  }
  for (const rel of cssEntries) {
    const hashed = cfg.hash && !extra.css.includes(rel);
    const provisional = hashed ? `${ctx.chunkDir}/${path.posix.basename(rel)}` : rel;
    const r = await buildCss(ctx, { entry: rel, outRel: provisional });
    if (r.error) {
      ctx.warn(`no se pudo procesar el CSS (${r.error}); se copia tal cual`, rel);
      cssOut.set(rel, ctx.emitCopy(rel, rel, 'copy-fallback'));
      ctx.cover(rel, 'copiado sin cambios (error al procesar)', rel);
      continue;
    }
    const outRel = hashed ? ctx.hashedPath(rel, r.code, '.css') : rel;
    ctx.emitCode(outRel, r.code, r.map, { type: 'css', action: 'bundle', sources: r.inputs, before: sumSizes(ctx, r.inputs) });
    cssOut.set(rel, outRel);
    for (const i of r.inputs) ctx.cover(i, i === rel ? 'procesado' : 'empaquetado', outRel);
  }

  // 4. Detección de white-space: pre (para no colapsar espacios del HTML)
  let collapse = cfg.html.collapseWhitespace;
  if (collapse === 'auto') {
    const cssText = [...ctx.files.keys()].filter((r) => CSS_EXT.has(extOf(r))).map((r) => ctx.readText(r, { kind: 'css' }).text);
    for (const p of pages.values()) htmlBlob.push(...p.model.styles.map((s) => s.code), ...p.model.styleAttrs.map((s) => s.value));
    const pre = detectPreWhitespace(cssText.join('\n') + htmlBlob.join('\n'));
    collapse = !pre;
    if (pre) ctx.note('se usa white-space: pre/pre-wrap/pre-line en el CSS; el HTML no colapsa espacios para no alterar ningún texto (html.collapseWhitespace: true lo fuerza)');
  }

  // 5. Scripts clásicos por página
  const classicCache = new Map();
  for (const page of fullPages) {
    for (const run of classicRuns(ctx, page)) {
      const files = run.items.map((c) => c.rel);
      const key = `${files.join('|')}\0${run.items[0].key}`;
      let out = classicCache.get(key);
      if (!out) {
        out = await processClassicRun(ctx, run, page);
        classicCache.set(key, out);
      }
      if (out.merged) {
        // El primer <script> apunta al archivo unido; los demás se quitan.
        const first = run.items[0];
        page.edits.push({ start: first.s.src.start, end: first.s.src.end, text: attrText('src', urlFor(ctx, page, first.s.src.value, out.outRel)) });
        for (const c of run.items.slice(1)) page.edits.push({ start: c.s.start, end: c.s.end, text: '' });
      } else {
        run.items.forEach((c, i) => {
          const o = out.outs[i];
          if (o.outRel !== c.rel) page.edits.push({ start: c.s.src.start, end: c.s.src.end, text: attrText('src', urlFor(ctx, page, c.s.src.value, o.outRel)) });
          if (o.changed) setIntegrity(ctx, page, c.s, 'src', ctx.outputBytes(o.outRel));
        });
      }
      for (const c of run.items) if (c.info.ok) ctx.noteJsInfo(c.rel, c.info, path.posix.dirname(c.rel) === '.' ? '' : path.posix.dirname(c.rel));
    }
  }

  // 6. Edición de cada página: módulos, CSS, inline, preload
  for (const page of fullPages) {
    for (const m of moduleRefs.filter((x) => x.page === page)) {
      const outRel = entryOut.get(`${m.group.key}\0${m.rel}`);
      if (!outRel) continue;
      if (outRel !== m.rel) page.edits.push({ start: m.s.src.start, end: m.s.src.end, text: attrText('src', urlFor(ctx, page, m.s.src.value, outRel)) });
      if (ctx.outputs.has(outRel)) setIntegrity(ctx, page, m.s, 'src', ctx.outputBytes(outRel));
    }
    for (const l of page.model.links) {
      if (l.type !== 'stylesheet') continue;
      const res = ctx.resolve(l.href.value, page.baseDir);
      if (res.status !== 'ok' || !cssOut.has(res.rel)) continue;
      const outRel = cssOut.get(res.rel);
      if (outRel !== res.rel) page.edits.push({ start: l.href.start, end: l.href.end, text: attrText('href', urlFor(ctx, page, l.href.value, outRel)) });
      setIntegrity(ctx, page, l, 'href', ctx.outputBytes(outRel));
    }
    for (const [id, v] of [...groups.values()].flatMap((g) => [...g.virtual.entries()])) {
      if (v.page !== page || !inlineModuleCode.has(id)) continue;
      page.edits.push({ start: v.s.inline.start, end: v.s.inline.end, text: escapeInlineScript(inlineModuleCode.get(id)) });
    }
  }
  for (const page of pages.values()) await processInline(ctx, page, collapse);

  // 7. Workers, archivos sueltos y rutas mencionadas (hasta que no aparezca nada nuevo)
  await drainQueues(ctx, cssOut);

  // 8. Archivos no referenciados
  const unref = [];
  for (const [rel, f] of ctx.files) {
    if (ctx.coverage.has(rel) || ctx.hasOwnOutput(rel) || HTML_EXT.has(f.ext)) continue;
    if (JS_EXT.has(f.ext) || CSS_EXT.has(f.ext)) unref.push(rel);
  }
  for (const rel of unref) {
    if (ctx.coverage.has(rel)) continue;
    const f = ctx.files.get(rel);
    if (cfg.unreferenced === 'process' || f.forced) ctx.requireStandalone(rel, 'no referenciado (se procesa suelto)');
    else if (cfg.unreferenced === 'copy') {
      ctx.emitCopy(rel, rel);
      ctx.cover(rel, 'no referenciado: copiado', rel);
    } else ctx.cover(rel, 'no referenciado: omitido (unreferenced: skip)');
  }
  await drainQueues(ctx, cssOut);

  // 9. Preloads y HTML final
  for (const { page, l } of preloadLinks) {
    const res = ctx.resolve(l.href.value, page.baseDir);
    if (res.status !== 'ok') continue;
    const target = cssOut.get(res.rel) ?? [...entryOut.entries()].find(([k]) => k.endsWith(`\0${res.rel}`))?.[1] ?? (ctx.hasOwnOutput(res.rel) || ctx.assets.has(res.rel) ? res.rel : null);
    if (target == null) {
      page.edits.push({ start: l.start, end: l.end, text: '' });
      ctx.note(`se quita <link rel="${l.rels.join(' ')}" href="${l.href.value}">: ese archivo ahora va dentro de un paquete`, page.rel);
    } else if (target !== res.rel) {
      page.edits.push({ start: l.href.start, end: l.href.end, text: attrText('href', urlFor(ctx, page, l.href.value, target)) });
    }
    if (target != null && l.attrs.has('integrity') && ctx.outputs.has(target)) setIntegrity(ctx, page, l, 'href', ctx.outputBytes(target));
  }
  for (const page of pages.values()) {
    const referenced = page.full || ctx.pageRefs.has(page.rel) || ctx.mentions.has(page.rel) || ctx.files.get(page.rel).forced;
    if (!referenced && cfg.unreferenced === 'skip') {
      ctx.cover(page.rel, 'no referenciado: omitido (unreferenced: skip)');
      continue;
    }
    if (!referenced && cfg.unreferenced === 'copy') {
      ctx.emitCopy(page.rel, page.rel);
      ctx.cover(page.rel, 'no referenciado: copiado', page.rel);
      continue;
    }
    await finalizePage(ctx, page, collapse);
  }

  // 10. Recursos: todo lo demás se copia (sin perder nada)
  for (const [rel, f] of ctx.files) {
    if (ctx.hasOwnOutput(rel)) {
      if (!ctx.coverage.has(rel)) ctx.cover(rel, 'procesado', rel);
      continue;
    }
    const cov = ctx.coverage.get(rel);
    // Empaquetar solo absorbe JS y CSS; un JSON importado se publica también por si se pide con fetch().
    if (cov && (JS_EXT.has(f.ext) || CSS_EXT.has(f.ext) || HTML_EXT.has(f.ext) || cov.some((s) => s.startsWith('no referenciado')))) continue;
    const referenced = ctx.assets.has(rel) || ctx.mentions.has(rel);
    if (cfg.unreferenced === 'skip' && !referenced && !f.forced) {
      ctx.cover(rel, 'no referenciado: omitido (unreferenced: skip)');
      continue;
    }
    if ((f.ext === '.json' || f.ext === '.webmanifest') && cfg.json.minify) {
      const raw = decodeUtf8(fs.readFileSync(f.abs));
      const min = raw == null ? null : minifyJsonText(stripBom(raw).text);
      if (min != null && Buffer.byteLength(min) < f.size) {
        ctx.emit(rel, min, { type: 'json', action: 'minify', sources: [rel], before: f.size });
        ctx.cover(rel, 'JSON minificado', rel);
        continue;
      }
    }
    ctx.emitCopy(rel, rel);
    ctx.cover(rel, 'copiado', rel);
  }

  // 11. Avisos de rutas mencionadas en el código que ya no existirán
  for (const [rel, from] of ctx.mentions) {
    if (!ctx.outputs.has(rel) && ctx.coverage.get(rel)?.every((s) => s.startsWith('empaquetado'))) {
      ctx.warn(`"${rel}" se menciona como texto en ${from} pero ya no existe por separado (va dentro de un paquete).`);
    }
  }
  if (cfg.hash) {
    for (const [rel, from] of ctx.mentions) {
      if ((cssOut.get(rel) ?? rel) !== rel)
        ctx.note(`"${rel}" se menciona como texto en ${from}: además de la versión con hash se publica en su ruta original.`);
    }
  }

  const result = {
    version: VERSION,
    root: cfg.root,
    outDir: cfg.outDir,
    mode,
    pages: { full: fullPages.map((p) => p.rel), conservative: partialPages.map((p) => p.rel) },
    outputs: ctx.outputs,
    coverage: ctx.coverage,
    ignored: ctx.ignored,
    broken: ctx.broken,
    warnings: ctx.warnings,
    notes: ctx.notes,
    workers: [...ctx.workers.entries()].map(([rel, w]) => ({ rel, ...w })),
    standalone: [...ctx.standalone.entries()].map(([rel, s]) => ({ rel, reason: s.reason })),
    report: buildReport(ctx.outputs),
    verify: null,
    durationMs: 0,
  };
  if (mode === 'analyze') {
    result.durationMs = Date.now() - t0;
    return result;
  }

  // 12. Escritura, verificación y publicación
  let staging;
  try {
    staging = await writeStaging(cfg, ctx.outputs);
    if (cfg.verify) {
      result.verify = await verifyOutput(staging, ctx.outputs, ctx);
      if (result.verify.errors.length) {
        if (!opts.keepFailed) await discardStaging(staging);
        throw new BuildError(`La verificación encontró ${result.verify.errors.length} problema(s); no se tocó ${cfg.outDir}.`, result.verify.errors);
      }
    }
    await writeManifest(staging, {
      tool: 'vanilla-builder',
      version: VERSION,
      builtAt: new Date().toISOString(),
      files: [...ctx.outputs.keys()].sort(),
    });
    await swapIntoPlace(cfg, staging);
  } catch (err) {
    if (staging && !opts.keepFailed) await discardStaging(staging);
    throw err;
  }
  result.durationMs = Date.now() - t0;
  return result;
}

function sumSizes(ctx, rels) {
  return rels.reduce((a, r) => a + (ctx.files.get(r)?.size ?? 0), 0);
}

function markModuleImport(ctx, spec, baseDir, from, importMap) {
  const c = classifyUrl(spec);
  if (c.type !== 'root' && c.type !== 'relative') {
    if (importMap?.imports && c.type !== 'external') {
      const target = Object.hasOwn(importMap.imports, spec)
        ? importMap.imports[spec]
        : Object.keys(importMap.imports)
            .filter((k) => k.endsWith('/') && spec.startsWith(k))
            .map((k) => importMap.imports[k] + spec.slice(k.length))[0];
      if (target) {
        const r = ctx.resolve(target, importMap.baseDir);
        if (r.status === 'ok') ctx.requireStandalone(r.rel, `importado desde ${from}`, { module: true });
      }
    }
    return;
  }
  const r = ctx.resolve(spec, baseDir);
  if (r.status === 'ok') ctx.requireStandalone(r.rel, `importado desde ${from}`, { module: true });
  else ctx.reportBroken(from, spec, r);
}

async function processClassicRun(ctx, run, page) {
  const items = run.items;
  const first = items[0];
  if (items.length === 1 && !first.info.ok) {
    ctx.warn(`no se pudo analizar (${first.info.error}); se copia sin cambios`, first.rel);
    const outRel = ctx.emitCopy(first.rel, first.rel, 'copy-fallback');
    ctx.cover(first.rel, 'copiado sin cambios (no se pudo analizar)', outRel);
    return { merged: false, outs: [{ outRel, changed: false }] };
  }
  if (items.length > 1) {
    // Separadores con ; y salto de línea: evitan que un archivo sin ; final se "pegue" al siguiente.
    const code = items.map((c) => ctx.readText(c.rel, { kind: 'js', charset: c.s.attrs.get('charset') }).text.replace(/\s*$/, '\n')).join(';\n');
    const info = analyzeJs(code, { module: false });
    if (info.ok) {
      const r = await processClassic(ctx, { code, id: items.map((c) => c.rel).join('+'), info, obfuscate: first.obf });
      for (const n of r.notes) ctx.note(n, `scripts unidos (${items.map((c) => c.rel).join(', ')})`);
      const outRel = ctx.emitCode(`${ctx.chunkDir}/scripts-${shortHash(r.code)}.js`, r.code, null, {
        type: 'js',
        action: 'merge',
        sources: items.map((c) => c.rel),
        before: sumSizes(ctx, items.map((c) => c.rel)),
      });
      for (const c of items) ctx.cover(c.rel, 'unido', outRel);
      return { merged: true, outRel };
    }
    ctx.warn(`no se pudieron unir (${info.error}); se procesan por separado`, page.rel);
  }
  // Un solo archivo, o una unión fallida: cada uno se procesa en su sitio.
  const outs = [];
  for (const c of items) {
    const { text } = ctx.readText(c.rel, { kind: 'js', charset: c.s.attrs.get('charset') });
    const r = await processClassic(ctx, { code: text, id: c.rel, info: c.info, obfuscate: c.obf, sourcemap: !!ctx.cfg.sourcemap });
    for (const n of r.notes) ctx.note(n, c.rel);
    if (c.reasons.length && c.reasons[0] !== 'unión desactivada') ctx.note(`no se une con otros scripts: ${c.reasons.join(', ')}`, c.rel);
    const outRel = ctx.cfg.hash ? ctx.hashedPath(c.rel, r.code, '.js') : c.rel;
    ctx.emitCode(outRel, r.code, r.map, { type: 'js', action: 'minify', sources: [c.rel], before: ctx.files.get(c.rel).size });
    ctx.cover(c.rel, 'procesado', outRel);
    outs.push({ outRel, changed: true });
  }
  return { merged: false, outs };
}

/** Scripts y estilos inline, atributos style y JSON inline de una página. */
async function processInline(ctx, page) {
  const cfg = ctx.cfg;
  for (const s of page.model.scripts) {
    if (s.src) {
      if (!page.full) {
        const res = ctx.resolve(s.src.value, page.baseDir);
        if (res.status === 'ok') ctx.requireStandalone(res.rel, `script en ${page.rel}`, { module: s.kind === 'module' });
        else if (res.status !== 'skip') ctx.reportBroken(page.rel, s.src.value, res);
      }
      continue;
    }
    if (!s.inline || !s.inline.code.trim()) continue;
    if (s.kind === 'classic') {
      const info = analyzeJs(s.inline.code, { module: false });
      if (!info.ok) {
        ctx.note(`un <script> inline no es JS estándar (¿plantilla?); se deja igual`, page.rel);
        continue;
      }
      ctx.noteJsInfo(page.rel, info, page.baseDir);
      const r = await processClassic(ctx, { code: s.inline.code, id: `${page.rel}#inline`, info, obfuscate: ctx.shouldObfuscate([page.rel]) });
      for (const n of r.notes) ctx.note(`script inline: ${n}`, page.rel);
      if (r.code !== s.inline.code) page.edits.push({ start: s.inline.start, end: s.inline.end, text: escapeInlineScript(r.code) });
    } else if (s.kind === 'module' && !page.full) {
      const info = analyzeJs(s.inline.code, { module: true });
      if (!info.ok) continue;
      ctx.noteJsInfo(page.rel, info, page.baseDir);
      for (const imp of info.imports) if (imp.spec) markModuleImport(ctx, imp.spec, page.baseDir, page.rel, null);
      const r = await processModuleStandalone(ctx, { code: s.inline.code, id: `${page.rel}#module`, info, obfuscate: ctx.shouldObfuscate([page.rel]) });
      if (r.code !== s.inline.code) page.edits.push({ start: s.inline.start, end: s.inline.end, text: escapeInlineScript(r.code) });
    } else if ((s.kind === 'json' || s.kind === 'importmap') && cfg.json.minify) {
      const min = minifyJsonText(s.inline.code.trim());
      if (min != null && min !== s.inline.code) page.edits.push({ start: s.inline.start, end: s.inline.end, text: escapeInlineScript(min) });
    }
  }
  if (!page.full) {
    for (const l of page.model.links) {
      if (l.type !== 'stylesheet') continue;
      const res = ctx.resolve(l.href.value, page.baseDir);
      if (res.status === 'ok') ctx.requireStandalone(res.rel, `hoja de estilos en ${page.rel}`);
      else if (res.status !== 'skip') ctx.reportBroken(page.rel, l.href.value, res);
    }
  }
  if (cfg.css.minify) {
    for (const st of page.model.styles) {
      if (!st.code.trim()) continue;
      const r = await buildCss(ctx, { inline: { code: st.code, baseDir: page.baseDir, label: `${page.rel} (<style>)` }, outRel: page.baseDir ? `${page.baseDir}/__page.html` : '__page.html' });
      if (r.error) {
        ctx.note(`un <style> no se pudo minificar (${r.error.split('\n')[0]}); se deja igual`, page.rel);
        continue;
      }
      if (r.code !== st.code) page.edits.push({ start: st.start, end: st.end, text: escapeInlineStyle(r.code) });
    }
    for (const a of page.model.styleAttrs) {
      const min = await minifyStyleAttr(a.value, cfg.css.target);
      if (min !== a.value) page.edits.push({ start: a.start, end: a.end, text: attrText('style', min) });
    }
  }
}

async function finalizePage(ctx, page, collapse) {
  let text;
  try {
    text = applyEdits(page.text, page.edits);
  } catch (err) {
    throw new BuildError(`Error interno al editar ${page.rel}: ${err.message}`);
  }
  const cfg = ctx.cfg;
  const notes = [];
  if (cfg.html.minify && page.encoding !== 'latin1') {
    const r = await minifyHtml(text, { removeComments: cfg.html.removeComments, collapseWhitespace: collapse });
    if (r.note) notes.push(r.note);
    text = r.code;
  }
  for (const n of notes) ctx.note(n, page.rel);
  const data = page.encoding === 'latin1' ? Buffer.from(text, 'latin1') : Buffer.from((page.bom ? BOM : '') + text, 'utf8');
  ctx.emit(page.rel, data, {
    type: 'html',
    action: page.full ? 'html' : 'html-conservative',
    sources: [page.rel],
    before: ctx.files.get(page.rel).size,
    encoding: page.encoding === 'latin1' ? 'latin1' : 'utf8',
    baseDir: page.baseDir,
    baseExternal: page.baseExternal,
  });
  ctx.cover(page.rel, page.full ? 'procesado' : 'procesado (modo conservador)', page.rel);
}

/** Procesa workers y archivos que deben existir sueltos en su ruta original, hasta agotar la cola. */
async function drainQueues(ctx, cssOut) {
  for (let round = 0; round < 50; round++) {
    let progressed = false;
    // Rutas mencionadas como texto (precache de service workers, fetch...) que fueron empaquetadas.
    for (const [rel] of ctx.mentions) {
      const ext = extOf(rel);
      if ((JS_EXT.has(ext) || CSS_EXT.has(ext)) && !ctx.hasOwnOutput(rel) && !ctx.standalone.has(rel)) ctx.requireStandalone(rel, `mencionado como texto en ${ctx.mentions.get(rel)}`);
      else if (!JS_EXT.has(ext) && !CSS_EXT.has(ext) && !HTML_EXT.has(ext)) ctx.registerAsset(rel, ctx.mentions.get(rel));
    }
    for (const [rel, w] of ctx.workers) {
      if (ctx.done.has(`w:${rel}`)) continue;
      ctx.done.add(`w:${rel}`);
      progressed = true;
      if (ctx.hasOwnOutput(rel)) continue;
      if (w.module) {
        const r = await buildModuleWorker(ctx, rel);
        if (r.error) {
          ctx.warn(`no se pudo empaquetar el worker (${r.error.split('\n')[0]}); se procesa suelto`, rel);
          ctx.requireStandalone(rel, 'worker (respaldo)', { module: true });
          continue;
        }
        let code = r.code;
        if (ctx.shouldObfuscate([rel])) {
          const o = obfuscateModule(ctx, code, rel);
          if (o.note) ctx.warn(o.note, rel);
          code = o.code;
        }
        const sources = [...r.consumed];
        ctx.emitCode(rel, code, code === r.code ? r.map : null, { type: 'js', module: true, action: 'worker', sources, before: sumSizes(ctx, sources) });
        for (const s of sources) ctx.cover(s, s === rel ? 'procesado (worker)' : 'empaquetado', rel);
      } else ctx.requireStandalone(rel, `worker clásico (${w.kind})`, { classic: true });
    }
    for (const [rel, s] of ctx.standalone) {
      if (ctx.done.has(`s:${rel}`)) continue;
      ctx.done.add(`s:${rel}`);
      progressed = true;
      if (ctx.hasOwnOutput(rel) || !ctx.files.has(rel)) continue;
      await processStandalone(ctx, rel, s, cssOut);
    }
    if (!progressed) return;
  }
  throw new BuildError('Demasiadas rondas al resolver dependencias (¿ciclo inesperado?).');
}

async function processStandalone(ctx, rel, s, cssOut) {
  const ext = extOf(rel);
  const dir = path.posix.dirname(rel) === '.' ? '' : path.posix.dirname(rel);
  if (CSS_EXT.has(ext)) {
    const r = await buildCss(ctx, { entry: rel, outRel: rel });
    if (r.error) {
      ctx.warn(`no se pudo procesar el CSS (${r.error.split('\n')[0]}); se copia tal cual`, rel);
      ctx.emitCopy(rel, rel, 'copy-fallback');
      ctx.cover(rel, 'copiado sin cambios (error al procesar)', rel);
      return;
    }
    ctx.emitCode(rel, r.code, r.map, { type: 'css', action: 'standalone', sources: [rel], before: ctx.files.get(rel).size });
    for (const i of r.inputs) ctx.cover(i, i === rel ? 'procesado (suelto)' : 'empaquetado', rel);
    if (!cssOut.has(rel)) cssOut.set(rel, rel);
    return;
  }
  if (!JS_EXT.has(ext)) {
    ctx.registerAsset(rel, s.reason);
    return;
  }
  const auto = ctx.jsInfo(rel, 'auto');
  const isModule = !s.classic && (s.module || (auto.ok && (auto.hasModuleSyntax || auto.hasImportMeta)) || (!auto.ok && auto.isModule));
  const info = isModule ? ctx.jsInfo(rel, true) : ctx.jsInfo(rel, false);
  if (!info.ok) {
    ctx.warn(`no se pudo analizar (${info.error}); se copia sin cambios`, rel);
    ctx.emitCopy(rel, rel, 'copy-fallback');
    ctx.cover(rel, 'copiado sin cambios (no se pudo analizar)', rel);
    return;
  }
  ctx.noteJsInfo(rel, info, dir);
  const { text } = ctx.readText(rel, { kind: 'js' });
  const obfuscate = ctx.shouldObfuscate([rel]);
  let r;
  if (isModule) {
    for (const imp of info.imports) if (imp.spec) markModuleImport(ctx, imp.spec, dir, rel, null);
    for (const u of info.urls) {
      const res = ctx.resolve(u.spec, dir);
      if (res.status === 'ok') ctx.urlTarget(res.rel, rel);
      else ctx.reportBroken(rel, u.spec, res);
    }
    r = await processModuleStandalone(ctx, { code: text, id: rel, info, obfuscate, sourcemap: !!ctx.cfg.sourcemap });
  } else {
    r = await processClassic(ctx, { code: text, id: rel, info, obfuscate, sourcemap: !!ctx.cfg.sourcemap });
  }
  for (const n of r.notes) ctx.note(n, rel);
  ctx.emitCode(rel, r.code, r.map, { type: 'js', module: isModule, action: 'standalone', sources: [rel], before: ctx.files.get(rel).size });
  ctx.cover(rel, `procesado suelto (${s.reason})`, rel);
}
