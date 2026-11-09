// Orquestador: descubre dependencias, procesa cada tipo de archivo, verifica y publica la salida.
import fs from 'node:fs';
import path from 'node:path';
import { createHeavy, defaultCacheDir, autoWorkers } from './pool.js';
import { gzipOf, brotliOf, mapLimit } from './compress.js';
import { scanProject, matchFiles, globMatcher } from './files.js';
import { resolveRef, classifyUrl, parseSrcset } from './urls.js';
import { analyzeJs } from './jsinfo.js';
import { parseHtml, adjacentSiblings, applyEdits, attrText, escapeInlineScript, escapeInlineStyle, minifyHtml, detectPreWhitespace } from './html.js';
import { buildCss, minifyStyleAttr } from './css.js';
import {
  processClassic,
  processModuleStandalone,
  buildModuleGroup,
  buildModuleWorker,
  obfuscateModule,
  ensureTerser,
  terserPass,
  levelOf,
} from './js.js';
import { resolveObfuscatorOptions, ensureObfuscator } from './obfuscate.js';
import { detectDependency, dependencyPragma, packageNames } from './deps.js';
import { assertSafeOutDir, writeStaging, swapIntoPlace, discardStaging, writeManifest, MANIFEST } from './output.js';
import { verifyOutput } from './verify.js';
import { rewriteTsImports } from './jsimports.js';
import { IMAGE_EXT, ensureSharp, imageOptions, optimizeImage } from './images.js';
import { checkBudgets } from './budgets.js';
import { TRANSFORM_EXT, runHook, runTransform } from './plugins.js';
import { buildReport } from './report.js';
import {
  BuildError,
  decodeUtf8,
  stripBom,
  BOM,
  extOf,
  JS_EXT,
  TS_EXT,
  jsOutPath,
  CSS_EXT,
  HTML_EXT,
  shortHash,
  sri,
  encodePath,
  minifyJsonText,
  hasOwn,
} from './util.js';
import { L } from './i18n.js';

export const VERSION = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

const MERGE_ATTRS = new Set(['src', 'type', 'defer', 'charset', 'language', 'data-builder']);
const typeOfExt = (ext) =>
  HTML_EXT.has(ext)
    ? 'html'
    : JS_EXT.has(ext)
      ? 'js'
      : CSS_EXT.has(ext)
        ? 'css'
        : ext === '.json' || ext === '.webmanifest'
          ? 'json'
          : ext === '.svg'
            ? 'svg'
            : ['.txt', '.xml', '.md', '.csv'].includes(ext)
              ? 'text'
              : 'asset';

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
    this.depIncluded = globMatcher(cfg.dependencies.include);
    this.depExcluded = globMatcher(cfg.dependencies.exclude);
    this.depCache = new Map();
    this.depMarks = new Map();
    this.tsCode = new Map();
    this.sourceOverrides = new Map();
    this.pkgNames = null;
    this.vendorPackages = [];
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
    // TypeScript: como JS se lee la versión ya transpilada (sin tipos; ya incluye los cambios de los plugins).
    if (kind === 'js' && this.tsCode.has(rel)) return { text: this.tsCode.get(rel), bom: false, encoding: 'utf8' };
    // Código fuente cambiado por un plugin (transform): es el que se procesa a partir de aquí.
    if (this.sourceOverrides.has(rel)) return { ...this.sourceOverrides.get(rel), encoding: 'utf8' };
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
        this.warn(
          L(
            'no es UTF-8; se conserva su codificación original y no se minifica',
            'is not UTF-8; its original encoding is kept and it is not minified',
          ),
          rel,
        );
      } else {
        let label = (charset || 'windows-1252').toLowerCase();
        try {
          text = new TextDecoder(label).decode(buf);
        } catch {
          label = 'windows-1252';
          text = new TextDecoder(label).decode(buf);
        }
        encoding = label;
        this.note(
          L(
            `no es UTF-8; se leyó como ${label} y la salida usa escapes ASCII (no depende de la codificación)`,
            `is not UTF-8; it was read as ${label} and the output uses ASCII escapes (independent of the encoding)`,
          ),
          rel,
        );
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
    if (r.status === 'ignored')
      this.warn(
        L(
          `referencia a "${url}", pero ese archivo está excluido (ignore). No se publicará.`,
          `references "${url}", but that file is excluded (ignore). It will not be published.`,
        ),
        from,
      );
    else if (r.status === 'case')
      this.warn(
        L(
          `"${url}" solo existe como "${r.rel}" (otras mayúsculas): en un servidor Linux daría 404.`,
          `"${url}" only exists as "${r.rel}" (different capitalization): it would be a 404 on a Linux server.`,
        ),
        from,
      );
    else if (r.status === 'missing')
      this.warn(
        L(`"${url}" no existe (ya estaba rota en el código fuente).`, `"${url}" does not exist (it was already broken in the source code).`),
        from,
      );
    else if (r.status === 'outside')
      this.note(L(`"${url}" apunta fuera del proyecto; se deja igual.`, `"${url}" points outside the project; left as is.`), from);
  }

  registerAsset(rel, from) {
    if (!this.assets.has(rel)) this.assets.set(rel, new Set());
    if (from) this.assets.get(rel).add(from);
    const ext = extOf(rel);
    if (JS_EXT.has(ext) || CSS_EXT.has(ext)) this.requireStandalone(rel, L(`referenciado desde ${from}`, `referenced from ${from}`));
  }

  assetOut(rel) {
    return rel;
  }

  /** Destino de new URL('...', import.meta.url): siempre la ruta original del archivo. */
  urlTarget(rel, from) {
    const ext = extOf(rel);
    if (JS_EXT.has(ext) || CSS_EXT.has(ext)) {
      if (!this.workers.has(rel)) this.requireStandalone(rel, L(`new URL() en ${from}`, `new URL() in ${from}`));
    } else this.registerAsset(rel, from);
    return jsOutPath(rel);
  }

  requireStandalone(rel, reason, extra = {}) {
    if (!this.standalone.has(rel)) this.standalone.set(rel, { reason, ...extra });
    else if (extra.module) this.standalone.get(rel).module = true;
  }

  registerWorker(rel, info) {
    const prev = this.workers.get(rel);
    if (prev) {
      if (prev.module !== info.module)
        this.warn(
          L(
            `se usa como worker clásico y de módulo a la vez; se trata como módulo`,
            `used as both a classic and a module worker; treated as a module`,
          ),
          rel,
        );
      prev.module = prev.module || info.module;
      return;
    }
    this.workers.set(rel, info);
  }

  /** Registra workers, service workers, importScripts y rutas mencionadas como texto. */
  noteJsInfo(id, info, baseDir) {
    for (const w of info.workers) {
      if (!w.spec) {
        this.warn(
          L(
            `${w.kind} con una ruta que no es texto fijo; Builder no puede seguirla (el archivo se procesará suelto si existe).`,
            `${w.kind} with a path that is not fixed text; Builder cannot follow it (the file will be processed on its own if it exists).`,
          ),
          id,
        );
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
      if (w.kind === 'importScripts') this.requireStandalone(rel, L(`importScripts en ${id}`, `importScripts in ${id}`), { classic: true });
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
    const o = this.outputs.get(rel) ?? (TS_EXT.has(extOf(rel)) ? this.outputs.get(jsOutPath(rel)) : undefined);
    return !!o && o.sources?.includes(rel);
  }

  /** ¿Es una librería de terceros? (a mano en dependencies.include/exclude, o detectada). */
  // Prioridad: configuración (include/exclude) > marca en el HTML o en el archivo > detección automática.
  dependencyReason(rel) {
    if (this.depCache.has(rel)) return this.depCache.get(rel);
    const deps = this.cfg.dependencies;
    const isJs = JS_EXT.has(extOf(rel)) && this.files.has(rel);
    const text = isJs ? this.readText(rel, { kind: 'js' }).text : '';
    const pragma = isJs ? dependencyPragma(text) : null;
    const mark = this.depMarks.get(rel);
    let reason = null;
    if (this.depExcluded(rel)) reason = null;
    else if (this.depIncluded(rel)) reason = 'marcado a mano (dependencies.include)';
    else if (mark === 'own' || pragma === 'own') reason = null;
    else if (mark === 'dependency') reason = L('marcado en el HTML (data-builder="dependency")', 'marked in the HTML (data-builder="dependency")');
    else if (pragma === 'dependency')
      reason = L('marcado en el propio archivo (@builder-dependency)', 'marked in the file itself (@builder-dependency)');
    else if (/(^|\/)node_modules\//.test(rel)) reason = L('paquete de npm', 'npm package');
    else if (deps.detect && isJs) reason = detectDependency(rel, text, { packages: this.packageHints() });
    this.depCache.set(rel, reason);
    return reason;
  }

  /** Paquetes del package.json más cercano (para reconocer librerías copiadas a mano). */
  packageHints() {
    if (this.pkgNames) return this.pkgNames;
    this.pkgNames = new Map();
    for (let dir = this.root, i = 0; i < 10; i++) {
      const file = path.join(dir, 'package.json');
      if (fs.existsSync(file)) {
        try {
          this.pkgNames = packageNames(JSON.parse(fs.readFileSync(file, 'utf8')));
        } catch {
          // package.json ilegible: no aporta pistas
        }
        break;
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    return this.pkgNames;
  }

  shouldObfuscate(rels) {
    if (!this.obfuscatorOptions) return false;
    const list = rels.filter(Boolean);
    if (!list.length) return false;
    if (this.cfg.dependencies.obfuscate) return true;
    return !list.every((r) => this.dependencyReason(r));
  }

  /** Registra un archivo de salida; nunca sobrescribe en silencio un contenido distinto. */
  emit(outRel, data, meta) {
    const norm = path.posix.normalize(outRel);
    if (norm.startsWith('../') || path.posix.isAbsolute(norm) || norm === MANIFEST)
      throw new BuildError(L(`Ruta de salida inválida: ${outRel}`, `Invalid output path: ${outRel}`));
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data, meta.encoding === 'latin1' ? 'latin1' : 'utf8');
    const prev = this.outputs.get(norm);
    if (prev) {
      const same = prev.copyFrom ? fs.readFileSync(prev.copyFrom).equals(buf) : prev.data.equals(buf);
      if (!same)
        throw new BuildError(
          L(`Dos resultados distintos quieren escribirse en "${norm}".`, `Two different results want to be written to "${norm}".`),
          [
            L(`Primero: ${(prev.sources ?? []).join(', ') || prev.action}`, `First: ${(prev.sources ?? []).join(', ') || prev.action}`),
            L(`Después: ${(meta.sources ?? []).join(', ') || meta.action}`, `Second: ${(meta.sources ?? []).join(', ') || meta.action}`),
            L(
              'Suele pasar si el mismo archivo se usa con import maps distintos o si una carpeta del proyecto se llama igual que js.chunkDir.',
              'This usually happens when the same file is used with different import maps, or when a project folder has the same name as js.chunkDir.',
            ),
          ],
        );
      prev.sources = [...new Set([...(prev.sources ?? []), ...(meta.sources ?? [])])];
      return norm;
    }
    const lower = norm.toLowerCase();
    if (this.outLower.has(lower) && this.outLower.get(lower) !== norm)
      this.warn(
        L(
          `"${norm}" y "${this.outLower.get(lower)}" solo se diferencian en mayúsculas; en Windows/macOS se pisarían.`,
          `"${norm}" and "${this.outLower.get(lower)}" differ only in capitalization; on Windows/macOS they would overwrite each other.`,
        ),
      );
    this.outLower.set(lower, norm);
    this.outputs.set(norm, { ...meta, data: buf });
    return norm;
  }

  emitCopy(outRel, rel, action = 'copy') {
    const f = this.files.get(rel);
    const override = this.sourceOverrides.get(rel);
    if (override) return this.emit(outRel, (override.bom ? BOM : '') + override.text, { type: typeOfExt(f.ext), action, sources: [rel] });
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
      ctx.warn(L(`no se pudo analizar el HTML (${err.message}); se copia tal cual`, `could not parse the HTML (${err.message}); copied as is`), rel);
      continue;
    }
    const dir = path.posix.dirname(rel) === '.' ? '' : path.posix.dirname(rel);
    const page = { rel, text, bom, encoding, model, dir, baseDir: dir, baseExternal: false, full: false, edits: [] };
    if (model.base != null) {
      const c = classifyUrl(model.base);
      if (c.type === 'external') {
        page.baseExternal = true;
        ctx.warn(
          L(
            `<base href="${model.base}"> apunta fuera del sitio; sus rutas relativas no se pueden comprobar y se dejan igual.`,
            `<base href="${model.base}"> points outside the site; its relative paths cannot be checked and are left as they are.`,
          ),
          rel,
        );
      } else if (c.type === 'root' || c.type === 'relative') {
        const p = c.type === 'root' ? (c.path.startsWith(ctx.base) ? c.path.slice(ctx.base.length) : c.path.slice(1)) : path.posix.join(dir, c.path);
        page.baseDir = path.posix
          .normalize(p.endsWith('/') ? p : path.posix.dirname(p))
          .replace(/^\.$/, '')
          .replace(/\/$/, '');
      }
    }
    pages.set(rel, page);
  }
  return pages;
}

/** Decide qué páginas se procesan completas (entradas + enlazadas) y cuáles en modo conservador. */
/** Pasa el código fuente por los plugins con transform (en paralelo entre archivos, en orden entre plugins). */
async function applyTransforms(ctx) {
  const plugins = ctx.cfg.plugins.filter((p) => typeof p.transform === 'function');
  if (!plugins.length) return;
  const list = [...ctx.files.keys()].filter((rel) => TRANSFORM_EXT.has(extOf(rel)));
  await mapLimit(list, 16, async (rel) => {
    const text = decodeUtf8(fs.readFileSync(ctx.abs(rel)));
    if (text == null) return; // otras codificaciones: se respetan los bytes originales
    const src = stripBom(text);
    const out = await runTransform(plugins, rel, src.text);
    if (out !== src.text) ctx.sourceOverrides.set(rel, { text: out, bom: src.bom });
  });
}

/**
 * Transpila cada archivo TypeScript a JavaScript (solo quita los tipos: no baja el nivel de sintaxis).
 * Usa el tsconfig.json del proyecto si existe. Lo que falle se avisa y sigue el camino normal
 * (se copia sin cambios), así que nunca se pierde nada.
 */
async function transpileTypeScript(ctx) {
  const list = [...ctx.files.keys()].filter((rel) => TS_EXT.has(extOf(rel)));
  if (!list.length) return;
  let tsconfigRaw;
  const tsconfig = path.join(ctx.root, 'tsconfig.json');
  if (fs.existsSync(tsconfig)) tsconfigRaw = fs.readFileSync(tsconfig, 'utf8');
  const esbuild = await import('esbuild');
  await mapLimit(list, 32, async (rel) => {
    const source = ctx.readText(rel, { kind: 'ts' }).text;
    try {
      const r = await esbuild.transform(source, {
        loader: 'ts',
        sourcefile: rel,
        target: 'esnext',
        tsconfigRaw,
        logLevel: 'silent',
        supported: { 'import-attributes': true },
      });
      const dir = path.posix.dirname(rel);
      // "./x" → la ruta que existirá en la salida (x.ts → x.js, x/index.ts → x/index.js…).
      const complete = (spec) => {
        const base = path.posix.normalize(path.posix.join(dir, spec));
        for (const cand of ['.ts', '.mts', '.js', '.mjs', '/index.ts', '/index.js'].map((s) => base + s)) {
          if (ctx.files.has(cand)) return spec + jsOutPath(cand).slice(base.length);
        }
        return null;
      };
      ctx.tsCode.set(rel, rewriteTsImports(r.code, complete));
    } catch (err) {
      const msg = String(err.errors?.[0]?.text ?? err.message).split('\n')[0];
      ctx.warn(L(`TypeScript no válido (${msg}); se copia sin transpilar`, `invalid TypeScript (${msg}); copied without transpiling`), rel);
    }
  });
}

/** <script src="..." data-builder="dependency|own">: el usuario marca librerías (o código propio) en el HTML. */
const MARK_VALUES = { dependency: 'dependency', dependencia: 'dependency', dep: 'dependency', own: 'own', propio: 'own' };
function markDependencies(ctx, pages) {
  for (const page of pages.values()) {
    for (const s of page.model.scripts) {
      if (!s.src || !s.attrs.has('data-builder')) continue;
      const raw = String(s.attrs.get('data-builder') ?? '')
        .trim()
        .toLowerCase();
      const value = MARK_VALUES[raw];
      if (!value) {
        ctx.warn(
          L(`data-builder="${raw}" no se reconoce; usa "dependency" o "own"`, `data-builder="${raw}" is not recognized; use "dependency" or "own"`),
          page.rel,
        );
        continue;
      }
      const res = ctx.resolve(s.src.value, page.baseDir);
      if (res.status !== 'ok') continue;
      const prev = ctx.depMarks.get(res.rel);
      if (prev && prev !== value)
        ctx.warn(
          L(
            `"${res.rel}" está marcado como "${prev}" y como "${value}" en distintas páginas; se usa "${prev}"`,
            `"${res.rel}" is marked as "${prev}" and as "${value}" on different pages; using "${prev}"`,
          ),
          page.rel,
        );
      else ctx.depMarks.set(res.rel, value);
    }
  }
}

function selectEntries(ctx, pages) {
  const cfg = ctx.cfg;
  const extraEntries = { modules: [], classic: [], css: [] };
  let queue = [];
  if (cfg.entries === 'auto') {
    queue = [...pages.values()].filter((p) => p.model.isDocument).map((p) => p.rel);
  } else {
    const { matched, missing } = matchFiles(ctx.files, cfg.entries);
    if (missing.length) throw new BuildError(L('Algunas entradas de "entries" no existen:', 'Some "entries" do not exist:'), missing);
    for (const rel of matched) {
      const ext = extOf(rel);
      if (HTML_EXT.has(ext)) queue.push(rel);
      else if (CSS_EXT.has(ext)) extraEntries.css.push(rel);
      else if (JS_EXT.has(ext)) {
        const info = ctx.jsInfo(rel);
        (info.ok && (info.hasModuleSyntax || info.hasImportMeta) ? extraEntries.modules : extraEntries.classic).push(rel);
      } else
        ctx.warn(
          L(`"${rel}" no es HTML, JS ni CSS; se copiará como recurso`, `"${rel}" is not HTML, JS or CSS; it will be copied as an asset`),
          'entries',
        );
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
    ctx.warn(
      L(`el import map no es JSON válido (${err.message}); se ignora`, `the import map is not valid JSON (${err.message}); ignored`),
      page.rel,
    );
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
    if (!JS_EXT.has(extOf(rel)))
      ctx.note(
        L(
          `<script src> apunta a "${rel}" (extensión no habitual); se trata como JavaScript`,
          `<script src> points to "${rel}" (unusual extension); treated as JavaScript`,
        ),
        page.rel,
      );
    const info = ctx.jsInfo(rel, false);
    const attrs = s.attrs;
    const reasons = [];
    if (!mergeOn) reasons.push(L('unión desactivada', 'merging disabled'));
    if (!info.ok) reasons.push(L('no se pudo analizar', 'could not be parsed'));
    if (s.inTemplate) reasons.push(L('dentro de <template>', 'inside <template>'));
    if (attrs.has('async')) reasons.push('async');
    if (info.usesCurrentScript) reasons.push(L('usa document.currentScript', 'uses document.currentScript'));
    if (info.usesDocumentWrite) reasons.push(L('usa document.write', 'uses document.write'));
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
    if (current && current.key === key && adjacentSiblings(current.items[current.items.length - 1].s, s) && !conflicts(current.names, info.top)) {
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
  const workers = cfg.workers === 'auto' ? autoWorkers() : cfg.workers;
  ctx.heavy = createHeavy({ root: cfg.root, workers, cacheDir: cfg.cache && mode === 'build' ? defaultCacheDir(cfg.root) : null });
  try {
    return await pipeline(ctx, cfg, opts, mode, t0);
  } finally {
    await ctx.heavy.close();
  }
}

async function pipeline(ctx, cfg, opts, mode, t0) {
  const log = opts.log ?? (() => {});
  const bt = cfg.browserTargets;
  if (bt?.missing)
    ctx.warn(
      L(
        `hay navegadores objetivo en ${bt.from}, pero falta el paquete "browserslist"; se ignoran (instálalo con: npm install --save-dev browserslist)`,
        `target browsers are set in ${bt.from}, but the "browserslist" package is missing; they are ignored (install it with: npm install --save-dev browserslist)`,
      ),
    );
  else if (bt?.targets?.length) {
    log(L(`Navegadores (${bt.from}): ${bt.targets.join(', ')}`, `Browsers (${bt.from}): ${bt.targets.join(', ')}`));
    if (bt.ignored.length)
      ctx.note(
        L(
          `navegadores sin motor equivalente en esbuild (se usan los demás): ${bt.ignored.join(', ')}`,
          `browsers without an equivalent esbuild engine (the others are used): ${bt.ignored.join(', ')}`,
        ),
      );
  } else if (bt && !bt.targets?.length)
    ctx.warn(
      L(
        `la consulta de navegadores de ${bt.from} no da ningún navegador conocido; se ignora`,
        `the browsers query in ${bt.from} matches no known browser; ignored`,
      ),
    );
  // Tiempo de cada fase (perf.phases): para saber dónde se va el tiempo en proyectos reales.
  const phases = [];
  let phaseStart = Date.now();
  let phaseName = 'setup';
  const mark = (next) => {
    const now = Date.now();
    phases.push([phaseName, now - phaseStart]);
    phaseName = next;
    phaseStart = now;
  };
  if (ctx.obfuscatorOptions) await ensureObfuscator(cfg.root);
  if (cfg.js.minifier === 'terser' && cfg.js.minify) await ensureTerser(cfg.root);
  const images = mode === 'build' ? imageOptions(cfg.images) : null;
  const sharp = images ? await ensureSharp(cfg.root) : null;

  mark('pages');
  // 1. Páginas y entradas
  await runHook(cfg.plugins, 'buildStart', { config: cfg, mode });
  await applyTransforms(ctx);
  await transpileTypeScript(ctx);
  const pages = loadPages(ctx);
  markDependencies(ctx, pages);
  const extra = selectEntries(ctx, pages);
  const fullPages = [...pages.values()].filter((p) => p.full);
  const partialPages = [...pages.values()].filter((p) => !p.full);
  log(
    L(
      `Páginas: ${fullPages.length} completas, ${partialPages.length} en modo conservador`,
      `Pages: ${fullPages.length} complete, ${partialPages.length} in conservative mode`,
    ),
  );
  const htmlBlob = [];
  for (const p of fullPages) collectRefs(ctx, p);
  for (const p of partialPages) collectRefs(ctx, p);

  mark('modules');
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
        forcePerFile: importMap?.scopes ? L('el import map usa "scopes"', 'the import map uses "scopes"') : null,
        vendorSplit: !!ctx.obfuscatorOptions && !cfg.dependencies.obfuscate,
      });
    return groups.get(key);
  };
  const moduleRefs = [];
  const preloadLinks = [];
  for (const page of fullPages) {
    const map = page.model.importMaps[0] ? parseImportMap(ctx, page, page.model.importMaps[0]) : null;
    if (page.model.importMaps.length > 1)
      ctx.warn(
        L('tiene varios import maps; solo se usa el primero para empaquetar', 'has several import maps; only the first one is used for bundling'),
        page.rel,
      );
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
        g.virtual.set(id, {
          code: s.inline.code,
          label: L(`${page.rel} (módulo inline ${vIndex})`, `${page.rel} (inline module ${vIndex})`),
          baseDir: page.baseDir,
          out: `${outDir}__vb_inline_${shortHash(id)}`,
          page,
          s,
        });
      }
    }
    for (const l of page.model.links) if (l.type === 'preload') preloadLinks.push({ page, l });
  }
  if (extra.modules.length) {
    const g = {
      key: '\0entries',
      importMap: null,
      hash: false,
      entries: new Set(extra.modules),
      virtual: new Map(),
      pages: new Set(),
      forcePerFile: null,
    };
    groups.set(g.key, g);
  }
  const entryOut = new Map(); // `${groupKey}\0${rel}` → outRel
  const inlineModuleCode = new Map(); // virtual id → código final
  for (const g of groups.values()) {
    if (!g.entries.size && !g.virtual.size) continue;
    const res = await buildModuleGroup(ctx, { ...g, hash: g.hash });
    if (res.mode === 'per-file') {
      ctx.note(
        L(
          `módulos sin empaquetar (cada archivo minificado en su sitio): ${res.reason}`,
          `modules not bundled (each file minified in place): ${res.reason}`,
        ),
        [...g.pages].join(', ') || 'entries',
      );
      for (const rel of res.inputs) ctx.requireStandalone(rel, L('módulo (modo sin empaquetar)', 'module (unbundled mode)'), { module: true });
      for (const rel of g.entries) entryOut.set(`${g.key}\0${rel}`, jsOutPath(rel));
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
    log(
      L(
        `Módulos: ${g.entries.size} entradas, ${res.inputs.length} archivos, target ${res.target}`,
        `Modules: ${g.entries.size} entries, ${res.inputs.length} files, target ${res.target}`,
      ),
    );
    // Ofuscar/comprimir cada salida en paralelo; registrar después en el orden original (salida determinista).
    const finals = await mapLimit(res.outputs, 64, async (o) => {
      const obfRels = o.virtualId ? [g.virtual.get(o.virtualId).page.rel] : o.isChunk ? o.inputs : [o.entry];
      if (!o.isVendor && ctx.shouldObfuscate(obfRels)) {
        const r = await obfuscateModule(ctx, o.code, o.outRel);
        return r.note ? { code: o.code, map: o.map, warn: r.note } : { code: r.code, map: null };
      }
      const t = await terserPass(ctx, o.code, { isModule: true, level: levelOf(res.target) });
      return t !== o.code ? { code: t, map: null } : { code: o.code, map: o.map };
    });
    for (const [i, o] of res.outputs.entries()) {
      const sources = o.inputs.length ? o.inputs : o.entry ? [o.entry] : [];
      const { code, map, warn } = finals[i];
      if (warn) ctx.warn(warn, o.outRel);
      if (o.virtualId) {
        const v = g.virtual.get(o.virtualId);
        inlineModuleCode.set(o.virtualId, code.replace(/\n$/, ''));
        for (const rel of o.inputs) ctx.cover(rel, L('empaquetado', 'bundled'), L(`${v.page.rel} (módulo inline)`, `${v.page.rel} (inline module)`));
        continue;
      }
      const action = o.isVendor ? 'vendor' : o.isChunk ? 'chunk' : 'bundle';
      const outRel = ctx.emitCode(o.outRel, code, map, { type: 'js', module: true, action, sources, before: o.before || sumSizes(ctx, sources) });
      if (o.entry) entryOut.set(`${g.key}\0${o.entry}`, outRel);
      for (const rel of o.inputs)
        ctx.cover(
          rel,
          o.isVendor ? L('empaquetado (dependencia, sin ofuscar)', 'bundled (dependency, not obfuscated)') : L('empaquetado', 'bundled'),
          outRel,
        );
    }
    for (const spec of res.vendor) if (!ctx.vendorPackages.includes(spec)) ctx.vendorPackages.push(spec);
    // esbuild puede incrustar un módulo entero (p. ej. constantes) sin que figure en ninguna salida.
    for (const rel of res.consumed) {
      if (!ctx.coverage.get(rel)?.some((s) => s.startsWith(L('empaquetado', 'bundled'))))
        ctx.cover(rel, L('empaquetado (incrustado por completo en el paquete)', 'bundled (fully inlined into the bundle)'));
    }
  }

  mark('css');
  // 3. CSS enlazado
  const cssOut = new Map();
  const cssEntries = new Set(extra.css);
  for (const page of fullPages)
    for (const l of page.model.links)
      if (l.type === 'stylesheet') {
        const res = ctx.resolve(l.href.value, page.baseDir);
        if (res.status === 'ok') cssEntries.add(res.rel);
        else if (res.status !== 'skip') ctx.reportBroken(page.rel, l.href.value, res);
      }
  const cssList = [...cssEntries];
  const cssBuilt = await mapLimit(cssList, 16, (rel) => {
    const hashed = cfg.hash && !extra.css.includes(rel);
    return buildCss(ctx, { entry: rel, outRel: hashed ? `${ctx.chunkDir}/${path.posix.basename(rel)}` : rel });
  });
  for (const [ci, rel] of cssList.entries()) {
    const hashed = cfg.hash && !extra.css.includes(rel);
    const r = cssBuilt[ci];
    if (r.error) {
      ctx.warn(L(`no se pudo procesar el CSS (${r.error}); se copia tal cual`, `could not process the CSS (${r.error}); copied as is`), rel);
      cssOut.set(rel, ctx.emitCopy(rel, rel, 'copy-fallback'));
      ctx.cover(rel, L('copiado sin cambios (error al procesar)', 'copied unchanged (processing error)'), rel);
      continue;
    }
    const outRel = hashed ? ctx.hashedPath(rel, r.code, '.css') : rel;
    ctx.emitCode(outRel, r.code, r.map, { type: 'css', action: 'bundle', sources: r.inputs, before: sumSizes(ctx, r.inputs) });
    cssOut.set(rel, outRel);
    for (const i of r.inputs) ctx.cover(i, i === rel ? L('procesado', 'processed') : L('empaquetado', 'bundled'), outRel);
  }

  mark('white-space');
  // 4. Detección de white-space: pre (para no colapsar espacios del HTML)
  let collapse = cfg.html.collapseWhitespace;
  if (collapse === 'auto') {
    const cssText = [...ctx.files.keys()].filter((r) => CSS_EXT.has(extOf(r))).map((r) => ctx.readText(r, { kind: 'css' }).text);
    for (const p of pages.values()) htmlBlob.push(...p.model.styles.map((s) => s.code), ...p.model.styleAttrs.map((s) => s.value));
    const pre = detectPreWhitespace(cssText.join('\n') + htmlBlob.join('\n'));
    collapse = !pre;
    if (pre)
      ctx.note(
        L(
          'se usa white-space: pre/pre-wrap/pre-line en el CSS; el HTML no colapsa espacios para no alterar ningún texto (html.collapseWhitespace: true lo fuerza)',
          'white-space: pre/pre-wrap/pre-line is used in the CSS; HTML whitespace is not collapsed so no text changes (html.collapseWhitespace: true forces it)',
        ),
      );
  }

  mark('classic scripts');
  // 5. Scripts clásicos por página
  // Primero se planifican todas las páginas, luego se minifica/ofusca cada grupo distinto en paralelo
  // y por último se registra todo en el orden original.
  const pageRuns = [];
  const uniqueRuns = new Map();
  for (const page of fullPages) {
    for (const run of classicRuns(ctx, page)) {
      const key = `${run.items.map((c) => c.rel).join('|')}\0${run.items[0].key}`;
      pageRuns.push({ page, run, key });
      if (!uniqueRuns.has(key)) uniqueRuns.set(key, run);
    }
  }
  const runKeys = [...uniqueRuns.keys()];
  const runResults = await mapLimit(runKeys, 64, (key) => computeClassicRun(ctx, uniqueRuns.get(key)));
  const computedRuns = new Map(runKeys.map((k, i) => [k, runResults[i]]));
  const classicCache = new Map();
  {
    for (const { page, run, key } of pageRuns) {
      let out = classicCache.get(key);
      if (!out) {
        out = commitClassicRun(ctx, run, page, computedRuns.get(key));
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
          if (o.outRel !== c.rel)
            page.edits.push({ start: c.s.src.start, end: c.s.src.end, text: attrText('src', urlFor(ctx, page, c.s.src.value, o.outRel)) });
          if (o.changed) setIntegrity(ctx, page, c.s, 'src', ctx.outputBytes(o.outRel));
        });
      }
      for (const c of run.items) if (c.info.ok) ctx.noteJsInfo(c.rel, c.info, path.posix.dirname(c.rel) === '.' ? '' : path.posix.dirname(c.rel));
    }
  }

  mark('html edits');
  // 6. Edición de cada página: módulos, CSS, inline, preload
  for (const page of fullPages) {
    for (const m of moduleRefs.filter((x) => x.page === page)) {
      const outRel = entryOut.get(`${m.group.key}\0${m.rel}`);
      if (!outRel) continue;
      if (outRel !== m.rel)
        page.edits.push({ start: m.s.src.start, end: m.s.src.end, text: attrText('src', urlFor(ctx, page, m.s.src.value, outRel)) });
      if (ctx.outputs.has(outRel)) setIntegrity(ctx, page, m.s, 'src', ctx.outputBytes(outRel));
    }
    for (const l of page.model.links) {
      if (l.type !== 'stylesheet') continue;
      const res = ctx.resolve(l.href.value, page.baseDir);
      if (res.status !== 'ok' || !cssOut.has(res.rel)) continue;
      const outRel = cssOut.get(res.rel);
      if (outRel !== res.rel)
        page.edits.push({ start: l.href.start, end: l.href.end, text: attrText('href', urlFor(ctx, page, l.href.value, outRel)) });
      setIntegrity(ctx, page, l, 'href', ctx.outputBytes(outRel));
    }
    for (const [id, v] of [...groups.values()].flatMap((g) => [...g.virtual.entries()])) {
      if (v.page !== page || !inlineModuleCode.has(id)) continue;
      page.edits.push({ start: v.s.inline.start, end: v.s.inline.end, text: escapeInlineScript(inlineModuleCode.get(id)) });
    }
  }
  for (const page of pages.values()) await processInline(ctx, page, collapse);

  mark('workers and standalone');
  // 7. Workers, archivos sueltos y rutas mencionadas (hasta que no aparezca nada nuevo)
  await drainQueues(ctx, cssOut);

  mark('unreferenced');
  // 8. Archivos no referenciados
  const unref = [];
  for (const [rel, f] of ctx.files) {
    if (ctx.coverage.has(rel) || ctx.hasOwnOutput(rel) || HTML_EXT.has(f.ext)) continue;
    if (JS_EXT.has(f.ext) || CSS_EXT.has(f.ext)) unref.push(rel);
  }
  for (const rel of unref) {
    if (ctx.coverage.has(rel)) continue;
    const f = ctx.files.get(rel);
    if (cfg.unreferenced === 'process' || f.forced)
      ctx.requireStandalone(rel, L('no referenciado (se procesa suelto)', 'unreferenced (processed on its own)'));
    else if (cfg.unreferenced === 'copy') {
      ctx.emitCopy(rel, rel);
      ctx.cover(rel, L('no referenciado: copiado', 'unreferenced: copied'), rel);
    } else ctx.cover(rel, L('no referenciado: omitido (unreferenced: skip)', 'unreferenced: skipped (unreferenced: skip)'));
  }
  await drainQueues(ctx, cssOut);

  mark('final html');
  // 9. Preloads y HTML final
  for (const { page, l } of preloadLinks) {
    const res = ctx.resolve(l.href.value, page.baseDir);
    if (res.status !== 'ok') continue;
    const target =
      cssOut.get(res.rel) ??
      [...entryOut.entries()].find(([k]) => k.endsWith(`\0${res.rel}`))?.[1] ??
      (ctx.hasOwnOutput(res.rel) || ctx.assets.has(res.rel) ? res.rel : null);
    if (target == null) {
      page.edits.push({ start: l.start, end: l.end, text: '' });
      ctx.note(
        L(
          `se quita <link rel="${l.rels.join(' ')}" href="${l.href.value}">: ese archivo ahora va dentro de un paquete`,
          `removed <link rel="${l.rels.join(' ')}" href="${l.href.value}">: that file is now inside a bundle`,
        ),
        page.rel,
      );
    } else if (target !== res.rel) {
      page.edits.push({ start: l.href.start, end: l.href.end, text: attrText('href', urlFor(ctx, page, l.href.value, target)) });
    }
    if (target != null && l.attrs.has('integrity') && ctx.outputs.has(target)) setIntegrity(ctx, page, l, 'href', ctx.outputBytes(target));
  }
  for (const page of pages.values()) {
    const referenced = page.full || ctx.pageRefs.has(page.rel) || ctx.mentions.has(page.rel) || ctx.files.get(page.rel).forced;
    if (!referenced && cfg.unreferenced === 'skip') {
      ctx.cover(page.rel, L('no referenciado: omitido (unreferenced: skip)', 'unreferenced: skipped (unreferenced: skip)'));
      continue;
    }
    if (!referenced && cfg.unreferenced === 'copy') {
      ctx.emitCopy(page.rel, page.rel);
      ctx.cover(page.rel, L('no referenciado: copiado', 'unreferenced: copied'), page.rel);
      continue;
    }
    await finalizePage(ctx, page, collapse);
  }

  mark('assets');
  // 10. Recursos: todo lo demás se copia (sin perder nada)
  const imageJobs = [];
  for (const [rel, f] of ctx.files) {
    if (ctx.hasOwnOutput(rel)) {
      if (!ctx.coverage.has(rel)) ctx.cover(rel, L('procesado', 'processed'), rel);
      continue;
    }
    const cov = ctx.coverage.get(rel);
    // Empaquetar solo absorbe JS y CSS; un JSON importado se publica también por si se pide con fetch().
    if (
      cov &&
      (JS_EXT.has(f.ext) || CSS_EXT.has(f.ext) || HTML_EXT.has(f.ext) || cov.some((s) => s.startsWith(L('no referenciado', 'unreferenced'))))
    )
      continue;
    const referenced = ctx.assets.has(rel) || ctx.mentions.has(rel);
    if (cfg.unreferenced === 'skip' && !referenced && !f.forced) {
      ctx.cover(rel, L('no referenciado: omitido (unreferenced: skip)', 'unreferenced: skipped (unreferenced: skip)'));
      continue;
    }
    if ((f.ext === '.json' || f.ext === '.webmanifest') && cfg.json.minify) {
      const raw = decodeUtf8(fs.readFileSync(f.abs));
      const min = raw == null ? null : minifyJsonText(stripBom(raw).text);
      if (min != null && Buffer.byteLength(min) < f.size) {
        ctx.emit(rel, min, { type: 'json', action: 'minify', sources: [rel], before: f.size });
        ctx.cover(rel, L('JSON minificado', 'JSON minified'), rel);
        continue;
      }
    }
    if (sharp && IMAGE_EXT.has(f.ext)) {
      imageJobs.push({ rel, f });
      continue;
    }
    ctx.emitCopy(rel, rel);
    ctx.cover(rel, L('copiado', 'copied'), rel);
  }
  // Imágenes: en paralelo (sharp usa sus propios hilos) y con caché por contenido; se registran en orden.
  const optimized = await mapLimit(imageJobs, 8, async ({ rel, f }) => {
    const buf = fs.readFileSync(f.abs);
    const r = await ctx.heavy.memo(`image:${f.ext}:q${images.quality}:sharp${sharp.versions?.sharp ?? '?'}`, buf, async () => {
      const o = await optimizeImage(sharp, buf, f.ext, images);
      return o.data ? { b64: o.data.toString('base64') } : { skip: o.skip };
    });
    return r.b64 ? { data: Buffer.from(r.b64, 'base64') } : r;
  });
  imageJobs.forEach(({ rel, f }, i) => {
    const o = optimized[i];
    if (o.data) {
      ctx.emit(rel, o.data, { type: 'asset', action: 'image', sources: [rel], before: f.size });
      ctx.cover(rel, L('imagen optimizada', 'image optimized'), rel);
    } else {
      ctx.emitCopy(rel, rel);
      ctx.cover(rel, L(`copiado (${o.skip})`, `copied (${o.skip})`), rel);
    }
  });

  mark('warnings');
  // 11. Avisos de rutas mencionadas en el código que ya no existirán
  for (const [rel, from] of ctx.mentions) {
    if (!ctx.outputs.has(rel) && ctx.coverage.get(rel)?.every((s) => s.startsWith(L('empaquetado', 'bundled')))) {
      ctx.warn(
        L(
          `"${rel}" se menciona como texto en ${from} pero ya no existe por separado (va dentro de un paquete).`,
          `"${rel}" is mentioned as text in ${from} but no longer exists on its own (it is inside a bundle).`,
        ),
      );
    }
  }
  if (cfg.hash) {
    for (const [rel, from] of ctx.mentions) {
      if ((cssOut.get(rel) ?? rel) !== rel)
        ctx.note(
          L(
            `"${rel}" se menciona como texto en ${from}: además de la versión con hash se publica en su ruta original.`,
            `"${rel}" is mentioned as text in ${from}: besides the hashed version, it is published at its original path.`,
          ),
        );
    }
  }

  mark('precompression');
  // 12. Precompresión .gz / .br para servidores que sirven archivos comprimidos (nginx gzip_static, etc.)
  if (cfg.compress && mode === 'build') await precompress(ctx, cfg.compress === true ? ['gzip', 'brotli'] : [cfg.compress]);

  mark('size report');
  const report = await buildReport(ctx.outputs, ctx.heavy);
  const budgets = checkBudgets(cfg.budgets, report);
  for (const p of budgets.unmatched)
    ctx.warn(L(`el presupuesto "${p}" no coincide con ningún archivo de salida`, `the budget "${p}" does not match any output file`));
  // En analyze los excesos son avisos; en build detienen la compilación antes de escribir nada.
  if (mode === 'analyze') for (const v of budgets.violations) ctx.warn(v);
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
    dependencies: [...ctx.files.keys()]
      .filter((rel) => JS_EXT.has(extOf(rel)) && ctx.dependencyReason(rel))
      .map((rel) => ({ rel, reason: ctx.dependencyReason(rel) })),
    vendor: ctx.vendorPackages,
    obfuscated: !!ctx.obfuscatorOptions,
    report,
    budgets,
    perf: Object.assign(ctx.heavy.stats, { phases }),
    verify: null,
    durationMs: 0,
  };
  if (mode === 'analyze') {
    mark('fin');
    result.durationMs = Date.now() - t0;
    return result;
  }

  mark('write and verify');
  // 12. Escritura, verificación y publicación
  if (budgets.violations.length)
    throw new BuildError(
      L(
        `${budgets.violations.length} archivo(s) superan su presupuesto de tamaño; no se tocó ${cfg.outDir}.`,
        `${budgets.violations.length} file(s) exceed their size budget; ${cfg.outDir} was not touched.`,
      ),
      budgets.violations,
    );
  let staging;
  try {
    staging = await writeStaging(cfg, ctx.outputs);
    if (cfg.verify) {
      result.verify = await verifyOutput(staging, ctx.outputs, ctx);
      if (result.verify.errors.length) {
        if (!opts.keepFailed) await discardStaging(staging);
        throw new BuildError(
          L(
            `La verificación encontró ${result.verify.errors.length} problema(s); no se tocó ${cfg.outDir}.`,
            `Verification found ${result.verify.errors.length} problem(s); ${cfg.outDir} was not touched.`,
          ),
          result.verify.errors,
        );
      }
    }
    await writeManifest(staging, {
      tool: 'vanilla-builder',
      version: VERSION,
      builtAt: new Date().toISOString(),
      files: [...ctx.outputs.keys()].sort(),
    });
    await swapIntoPlace(cfg, staging);
    await runHook(cfg.plugins, 'buildEnd', { result, outDir: cfg.outDir });
    mark('fin');
  } catch (err) {
    if (staging && !opts.keepFailed) await discardStaging(staging);
    throw err;
  }
  result.durationMs = Date.now() - t0;
  return result;
}

const COMPRESS_TYPES = new Set(['html', 'css', 'js', 'json', 'svg', 'text', 'map']);

async function precompress(ctx, kinds) {
  const items = [...ctx.outputs].filter(([, o]) => COMPRESS_TYPES.has(o.type));
  // En paralelo (pool de hilos de libuv); se registra en orden. El informe reutiliza estos mismos resultados.
  const done = await mapLimit(items, 64, async ([, o]) => {
    const buf = o.copyFrom ? fs.readFileSync(o.copyFrom) : o.data;
    if (buf.length < 1024) return null; // no compensa
    const [gz, br] = await Promise.all([kinds.includes('gzip') ? gzipOf(buf) : null, kinds.includes('brotli') ? brotliOf(buf) : null]);
    return { buf, gz, br };
  });
  items.forEach(([rel, o], i) => {
    const d = done[i];
    if (!d) return;
    if (d.gz && d.gz.length < d.buf.length) ctx.emit(`${rel}.gz`, d.gz, { type: 'compressed', action: 'gzip', sources: o.sources });
    if (d.br && d.br.length < d.buf.length) ctx.emit(`${rel}.br`, d.br, { type: 'compressed', action: 'brotli', sources: o.sources });
  });
}

function sumSizes(ctx, rels) {
  return rels.reduce((a, r) => a + (ctx.files.get(r)?.size ?? 0), 0);
}

function markModuleImport(ctx, spec, baseDir, from, importMap) {
  const c = classifyUrl(spec);
  if (c.type !== 'root' && c.type !== 'relative') {
    if (importMap?.imports && c.type !== 'external') {
      const target = hasOwn(importMap.imports, spec)
        ? importMap.imports[spec]
        : Object.keys(importMap.imports)
            .filter((k) => k.endsWith('/') && spec.startsWith(k))
            .map((k) => importMap.imports[k] + spec.slice(k.length))[0];
      if (target) {
        const r = ctx.resolve(target, importMap.baseDir);
        if (r.status === 'ok') ctx.requireStandalone(r.rel, L(`importado desde ${from}`, `imported from ${from}`), { module: true });
      }
    }
    return;
  }
  const r = ctx.resolve(spec, baseDir);
  if (r.status === 'ok') ctx.requireStandalone(r.rel, L(`importado desde ${from}`, `imported from ${from}`), { module: true });
  else ctx.reportBroken(from, spec, r);
}

/** Parte costosa y sin efectos de un grupo de scripts clásicos: unir, minificar y ofuscar. */
async function computeClassicRun(ctx, run) {
  const items = run.items;
  const first = items[0];
  if (items.length === 1 && !first.info.ok) return { copy: true };
  let mergeError = null;
  if (items.length > 1) {
    // Separadores con ; y salto de línea: evitan que un archivo sin ; final se "pegue" al siguiente.
    const code = items.map((c) => ctx.readText(c.rel, { kind: 'js', charset: c.s.attrs.get('charset') }).text.replace(/\s*$/, '\n')).join(';\n');
    const info = analyzeJs(code, { module: false });
    if (info.ok) return { merged: await processClassic(ctx, { code, id: items.map((c) => c.rel).join('+'), info, obfuscate: first.obf }) };
    mergeError = info.error;
  }
  const separate = await Promise.all(
    items.map((c) => {
      const { text } = ctx.readText(c.rel, { kind: 'js', charset: c.s.attrs.get('charset') });
      return processClassic(ctx, { code: text, id: c.rel, info: c.info, obfuscate: c.obf, sourcemap: !!ctx.cfg.sourcemap });
    }),
  );
  return { separate, mergeError };
}

/** Registra el resultado de computeClassicRun (salidas, cobertura y notas) en orden. */
function commitClassicRun(ctx, run, page, comp) {
  const items = run.items;
  const first = items[0];
  if (comp.copy) {
    ctx.warn(
      L(`no se pudo analizar (${first.info.error}); se copia sin cambios`, `could not be parsed (${first.info.error}); copied unchanged`),
      first.rel,
    );
    const outRel = ctx.emitCopy(first.rel, first.rel, 'copy-fallback');
    ctx.cover(first.rel, L('copiado sin cambios (no se pudo analizar)', 'copied unchanged (could not be parsed)'), outRel);
    return { merged: false, outs: [{ outRel, changed: false }] };
  }
  {
    if (comp.merged) {
      const r = comp.merged;
      for (const n of r.notes) ctx.note(n, `scripts unidos (${items.map((c) => c.rel).join(', ')})`);
      const outRel = ctx.emitCode(`${ctx.chunkDir}/scripts-${shortHash(r.code)}.js`, r.code, null, {
        type: 'js',
        action: 'merge',
        sources: items.map((c) => c.rel),
        before: sumSizes(
          ctx,
          items.map((c) => c.rel),
        ),
      });
      for (const c of items) ctx.cover(c.rel, L('unido', 'merged'), outRel);
      return { merged: true, outRel };
    }
    if (comp.mergeError)
      ctx.warn(
        L(`no se pudieron unir (${comp.mergeError}); se procesan por separado`, `could not be merged (${comp.mergeError}); processed separately`),
        page.rel,
      );
  }
  // Un solo archivo, o una unión fallida: cada uno se procesa en su sitio.
  const outs = [];
  for (const [i, c] of items.entries()) {
    const r = comp.separate[i];
    for (const n of r.notes) ctx.note(n, c.rel);
    if (c.reasons.length && c.reasons[0] !== L('unión desactivada', 'merging disabled'))
      ctx.note(L(`no se une con otros scripts: ${c.reasons.join(', ')}`, `not merged with other scripts: ${c.reasons.join(', ')}`), c.rel);
    const outRel = ctx.cfg.hash ? ctx.hashedPath(c.rel, r.code, '.js') : jsOutPath(c.rel);
    ctx.emitCode(outRel, r.code, r.map, { type: 'js', action: 'minify', sources: [c.rel], before: ctx.files.get(c.rel).size });
    ctx.cover(c.rel, L('procesado', 'processed'), outRel);
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
        if (res.status === 'ok') ctx.requireStandalone(res.rel, L(`script en ${page.rel}`, `script in ${page.rel}`), { module: s.kind === 'module' });
        else if (res.status !== 'skip') ctx.reportBroken(page.rel, s.src.value, res);
      }
      continue;
    }
    if (!s.inline || !s.inline.code.trim()) continue;
    if (s.kind === 'classic') {
      const info = analyzeJs(s.inline.code, { module: false });
      if (!info.ok) {
        ctx.note(
          L(`un <script> inline no es JS estándar (¿plantilla?); se deja igual`, `an inline <script> is not standard JS (a template?); left as is`),
          page.rel,
        );
        continue;
      }
      ctx.noteJsInfo(page.rel, info, page.baseDir);
      const r = await processClassic(ctx, { code: s.inline.code, id: `${page.rel}#inline`, info, obfuscate: ctx.shouldObfuscate([page.rel]) });
      for (const n of r.notes) ctx.note(`script inline: ${n}`, page.rel);
      if (r.code !== s.inline.code)
        page.edits.push({ start: s.inline.start, end: s.inline.end, text: escapeInlineScript(r.code.replace(/\n$/, '')) });
    } else if (s.kind === 'module' && !page.full) {
      const info = analyzeJs(s.inline.code, { module: true });
      if (!info.ok) continue;
      ctx.noteJsInfo(page.rel, info, page.baseDir);
      for (const imp of info.imports) if (imp.spec) markModuleImport(ctx, imp.spec, page.baseDir, page.rel, null);
      const r = await processModuleStandalone(ctx, {
        code: s.inline.code,
        id: `${page.rel}#module`,
        info,
        obfuscate: ctx.shouldObfuscate([page.rel]),
      });
      if (r.code !== s.inline.code)
        page.edits.push({ start: s.inline.start, end: s.inline.end, text: escapeInlineScript(r.code.replace(/\n$/, '')) });
    } else if ((s.kind === 'json' || s.kind === 'importmap') && cfg.json.minify) {
      const min = minifyJsonText(s.inline.code.trim());
      if (min != null && min !== s.inline.code) page.edits.push({ start: s.inline.start, end: s.inline.end, text: escapeInlineScript(min) });
    }
  }
  if (!page.full) {
    for (const l of page.model.links) {
      if (l.type !== 'stylesheet') continue;
      const res = ctx.resolve(l.href.value, page.baseDir);
      if (res.status === 'ok') ctx.requireStandalone(res.rel, L(`hoja de estilos en ${page.rel}`, `stylesheet in ${page.rel}`));
      else if (res.status !== 'skip') ctx.reportBroken(page.rel, l.href.value, res);
    }
  }
  if (cfg.css.minify) {
    for (const st of page.model.styles) {
      if (!st.code.trim()) continue;
      const r = await buildCss(ctx, {
        inline: { code: st.code, baseDir: page.baseDir, label: `${page.rel} (<style>)` },
        outRel: page.baseDir ? `${page.baseDir}/__page.html` : '__page.html',
      });
      if (r.error) {
        ctx.note(
          L(
            `un <style> no se pudo minificar (${r.error.split('\n')[0]}); se deja igual`,
            `a <style> could not be minified (${r.error.split('\n')[0]}); left as is`,
          ),
          page.rel,
        );
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
  ctx.cover(page.rel, page.full ? L('procesado', 'processed') : L('procesado (modo conservador)', 'processed (conservative mode)'), page.rel);
}

/** Procesa workers y archivos que deben existir sueltos en su ruta original, hasta agotar la cola. */
async function drainQueues(ctx, cssOut) {
  for (let round = 0; round < 50; round++) {
    let progressed = false;
    // Rutas mencionadas como texto (precache de service workers, fetch...) que fueron empaquetadas.
    for (const [rel] of ctx.mentions) {
      const ext = extOf(rel);
      if ((JS_EXT.has(ext) || CSS_EXT.has(ext)) && !ctx.hasOwnOutput(rel) && !ctx.standalone.has(rel))
        ctx.requireStandalone(rel, L(`mencionado como texto en ${ctx.mentions.get(rel)}`, `mentioned as text in ${ctx.mentions.get(rel)}`));
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
          ctx.warn(
            L(
              `no se pudo empaquetar el worker (${r.error.split('\n')[0]}); se procesa suelto`,
              `could not bundle the worker (${r.error.split('\n')[0]}); processed on its own`,
            ),
            rel,
          );
          ctx.requireStandalone(rel, 'worker (respaldo)', { module: true });
          continue;
        }
        let code = r.code;
        if (ctx.shouldObfuscate([rel])) {
          const o = await obfuscateModule(ctx, code, rel);
          if (o.note) ctx.warn(o.note, rel);
          code = o.code;
        } else code = await terserPass(ctx, code, { isModule: true, level: 2020 });
        const sources = [...r.consumed];
        ctx.emitCode(jsOutPath(rel), code, code === r.code ? r.map : null, {
          type: 'js',
          module: true,
          action: 'worker',
          sources,
          before: sumSizes(ctx, sources),
        });
        for (const s of sources)
          ctx.cover(s, s === rel ? L('procesado (worker)', 'processed (worker)') : L('empaquetado', 'bundled'), jsOutPath(rel));
      } else ctx.requireStandalone(rel, L(`worker clásico (${w.kind})`, `classic worker (${w.kind})`), { classic: true });
    }
    // Análisis en orden, trabajo pesado en paralelo, registro otra vez en orden.
    const jobs = [];
    for (const [rel, s] of ctx.standalone) {
      if (ctx.done.has(`s:${rel}`)) continue;
      ctx.done.add(`s:${rel}`);
      progressed = true;
      if (ctx.hasOwnOutput(rel) || !ctx.files.has(rel)) continue;
      const job = planStandalone(ctx, rel, s, cssOut);
      if (job) jobs.push(job);
    }
    const results = await mapLimit(jobs, 64, (j) => j.run());
    jobs.forEach((j, i) => j.commit(results[i]));
    if (!progressed) return;
  }
  throw new BuildError(
    L('Demasiadas rondas al resolver dependencias (¿ciclo inesperado?).', 'Too many rounds resolving dependencies (unexpected cycle?).'),
  );
}

/**
 * Prepara un archivo suelto: el análisis (que descubre más dependencias) se hace ya, en orden;
 * devuelve {run, commit}: run() es la parte costosa y sin efectos, commit() registra el resultado.
 */
function planStandalone(ctx, rel, s, cssOut) {
  const ext = extOf(rel);
  const dir = path.posix.dirname(rel) === '.' ? '' : path.posix.dirname(rel);
  if (CSS_EXT.has(ext)) {
    // buildCss registra los recursos de url() mientras compila: eso solo añade trabajo a la siguiente ronda.
    return {
      run: () => buildCss(ctx, { entry: rel, outRel: rel }),
      commit: (r) => {
        if (r.error) {
          ctx.warn(
            L(
              `no se pudo procesar el CSS (${r.error.split('\n')[0]}); se copia tal cual`,
              `could not process the CSS (${r.error.split('\n')[0]}); copied as is`,
            ),
            rel,
          );
          ctx.emitCopy(rel, rel, 'copy-fallback');
          ctx.cover(rel, L('copiado sin cambios (error al procesar)', 'copied unchanged (processing error)'), rel);
          return;
        }
        ctx.emitCode(rel, r.code, r.map, { type: 'css', action: 'standalone', sources: [rel], before: ctx.files.get(rel).size });
        for (const i of r.inputs) ctx.cover(i, i === rel ? L('procesado (suelto)', 'processed (standalone)') : L('empaquetado', 'bundled'), rel);
        if (!cssOut.has(rel)) cssOut.set(rel, rel);
      },
    };
  }
  if (!JS_EXT.has(ext)) {
    ctx.registerAsset(rel, s.reason);
    return null;
  }
  const auto = ctx.jsInfo(rel, 'auto');
  const isModule = !s.classic && (s.module || (auto.ok && (auto.hasModuleSyntax || auto.hasImportMeta)) || (!auto.ok && auto.isModule));
  const info = isModule ? ctx.jsInfo(rel, true) : ctx.jsInfo(rel, false);
  if (!info.ok) {
    ctx.warn(L(`no se pudo analizar (${info.error}); se copia sin cambios`, `could not be parsed (${info.error}); copied unchanged`), rel);
    ctx.emitCopy(rel, rel, 'copy-fallback');
    ctx.cover(rel, L('copiado sin cambios (no se pudo analizar)', 'copied unchanged (could not be parsed)'), rel);
    return null;
  }
  ctx.noteJsInfo(rel, info, dir);
  const { text } = ctx.readText(rel, { kind: 'js' });
  const obfuscate = ctx.shouldObfuscate([rel]);
  if (isModule) {
    for (const imp of info.imports) if (imp.spec) markModuleImport(ctx, imp.spec, dir, rel, null);
    for (const u of info.urls) {
      const res = ctx.resolve(u.spec, dir);
      if (res.status === 'ok') ctx.urlTarget(res.rel, rel);
      else ctx.reportBroken(rel, u.spec, res);
    }
  }
  const job = { code: text, id: rel, info, obfuscate, sourcemap: !!ctx.cfg.sourcemap };
  return {
    run: () => (isModule ? processModuleStandalone(ctx, job) : processClassic(ctx, job)),
    commit: (r) => {
      for (const n of r.notes) ctx.note(n, rel);
      const out = jsOutPath(rel);
      ctx.emitCode(out, r.code, r.map, { type: 'js', module: isModule, action: 'standalone', sources: [rel], before: ctx.files.get(rel).size });
      ctx.cover(rel, L(`procesado suelto (${s.reason})`, `processed standalone (${s.reason})`), out);
    },
  };
}
