#!/usr/bin/env node
// Línea de comandos de Builder: build, analyze, init, dev y serve.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { loadConfig, findConfigFile } from '../src/config.js';
import { runPipeline, VERSION } from '../src/builder.js';
import { renderReport } from '../src/report.js';
import { startServer } from '../src/server.js';
import { watchTree } from '../src/watch.js';
import { BuildError, formatBytes, relFrom, isInside, JS_EXT, extOf, toPosix } from '../src/util.js';
import { globMatcher } from '../src/files.js';

const tty = process.stdout.isTTY && !process.env.NO_COLOR;
const color = (code) => (text) => (tty ? `\x1b[${code}m${text}\x1b[0m` : String(text));
const C = { red: color(31), yellow: color(33), green: color(32), blue: color(34), gray: color(90), bold: color(1), cyan: color(36) };

const HELP = `Builder ${VERSION} — empaqueta, minifica y ofusca proyectos web vanilla (HTML, CSS y JS)

Uso:
  builder build   [carpeta] [opciones]   Compila el proyecto en dist/ (por defecto)
  builder analyze [carpeta] [--json]     Muestra dependencias detectadas y la salida prevista, sin escribir
  builder init    [carpeta] [--force]    Crea builder.config.json con lo detectado
  builder deps    [carpeta]              Lista qué JS son librerías de terceros (no se ofuscan) y cuáles son tuyos
  builder deps add|own|reset <patrón…>   Marca librerías (add), tu código (own) o vuelve a lo automático (reset)
  builder dev     [carpeta] [--port N]   Compila, vigila cambios y sirve dist/ con recarga automática
  builder serve   [carpeta] [--port N]   Sirve la carpeta de salida para probarla

Marcar dependencias sin configuración:
  En el HTML:        <script src="js/lib.js" data-builder="dependency"></script>   (o "own")
  En el archivo:     /* @builder-dependency */  al principio                       (o @builder-own)
  Con deps:          builder deps add "js/libs/**"   (en otra carpeta: --dir <carpeta>)

Opciones de build:
  --out <carpeta>          Carpeta de salida (por defecto dist)
  --config <archivo>       Archivo de configuración (por defecto builder.config.json)
  --entry <archivo>        Entrada explícita (repetible). Por defecto: todos los .html completos
  --include <patrón>       Fuerza incluir archivos (repetible), ej. "data/**"
  --ignore <patrón>        Excluye archivos (repetible), ej. "borradores/**"
  --obfuscate [nivel]      Ofusca tu JS: low | medium | high | max (por defecto medium)
                           Las librerías de terceros se detectan solas y NO se ofuscan.
  --dep <patrón>           Marca a mano archivos como dependencia (no se ofuscan), repetible
  --not-dep <patrón>       Corrige la detección: ese archivo es tuyo y sí se ofusca, repetible
  --obfuscate-deps         Ofusca también las dependencias
  --minifier terser        Compresión máxima del JS con una segunda pasada de terser
  --compress [gzip|brotli] Genera además .gz y .br precomprimidos (por defecto ambos)
  --hash                   Nombres con hash en JS/CSS (caché a largo plazo)
  --sourcemap [modo]       Genera source maps (linked | hidden | inline)
  --target <target>        Navegadores/ES de salida, ej. es2018 (por defecto: el del propio código)
  --drop-console           Quita console.* y debugger
  --no-minify              No minifica (útil para depurar)
  --no-merge               No une scripts clásicos consecutivos
  --unreferenced <modo>    Archivos no referenciados: process | copy | skip (por defecto process)
  --base <ruta>            Ruta base del sitio para URLs absolutas (por defecto /)
  --workers <n|auto>       Hilos para ofuscar/comprimir en paralelo (0 = sin hilos; por defecto auto)
  --no-cache               No usa la caché de compilaciones anteriores
  --no-verify              Omite la verificación final (no recomendado)
  --force                  Permite vaciar una carpeta de salida que no creó Builder
  --keep-failed            Conserva la carpeta temporal si la verificación falla
  --json                   Resultado en JSON (para CI)
  --verbose                Muestra notas, archivos copiados y excluidos
  --quiet                  Solo errores
`;

function parseArgs(argv) {
  const args = { _: [], entry: [], include: [], ignore: [], dep: [], 'not-dep': [] };
  const takesValue = new Set([
    'out',
    'config',
    'entry',
    'include',
    'ignore',
    'target',
    'unreferenced',
    'base',
    'port',
    'host',
    'dep',
    'not-dep',
    'minifier',
    'workers',
    'dir',
  ]);
  const optionalValue = { obfuscate: ['low', 'medium', 'high', 'max'], sourcemap: ['linked', 'hidden', 'inline'], compress: ['gzip', 'brotli'] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) {
      args._.push(a);
      continue;
    }
    let [key, val] = a.slice(2).split(/=(.*)/s);
    if (takesValue.has(key)) {
      if (val === undefined) val = argv[++i];
      if (val === undefined) throw new BuildError(`Falta el valor de --${key}.`);
      if (Array.isArray(args[key])) args[key].push(val);
      else args[key] = val;
    } else if (optionalValue[key]) {
      if (val === undefined && optionalValue[key].includes(argv[i + 1])) val = argv[++i];
      args[key] = val ?? true;
    } else if (key.startsWith('no-')) args[key.slice(3)] = false;
    else args[key] = val ?? true;
  }
  return args;
}

function overridesFrom(args) {
  const o = {};
  if (args.out) o.outDir = args.out;
  if (args.entry.length) o.entries = args.entry;
  if (args.include.length) o.include = args.include;
  if (args.ignore.length) o.ignore = args.ignore;
  if (args.obfuscate !== undefined) o.obfuscate = args.obfuscate === true ? 'medium' : args.obfuscate;
  if (args.hash !== undefined) o.hash = !!args.hash;
  if (args.sourcemap !== undefined) o.sourcemap = args.sourcemap === 'linked' ? true : args.sourcemap;
  if (args.unreferenced) o.unreferenced = args.unreferenced;
  if (args.base) o.base = args.base;
  if (args.verify === false) o.verify = false;
  if (args.compress !== undefined) o.compress = args.compress;
  if (args.cache === false) o.cache = false;
  if (args.workers !== undefined) {
    const n = Number(args.workers);
    if (args.workers !== 'auto' && !(Number.isInteger(n) && n >= 0)) throw new BuildError('--workers debe ser "auto" o un número (0 = sin hilos).');
    o.workers = args.workers === 'auto' ? 'auto' : n;
  }
  const deps = {};
  if (args.dep.length) deps.include = args.dep;
  if (args['not-dep'].length) deps.exclude = args['not-dep'];
  if (args['obfuscate-deps']) deps.obfuscate = true;
  if (args['detect-deps'] === false) deps.detect = false;
  if (Object.keys(deps).length) o.dependencies = deps;
  const js = {};
  if (args.target) js.target = args.target;
  if (args['drop-console']) js.drop = ['console', 'debugger'];
  if (args.merge === false) js.mergeClassic = false;
  if (args.minifier) js.minifier = args.minifier;
  if (args.minify === false) {
    js.minify = false;
    o.css = { minify: false };
    o.html = { minify: false };
  }
  if (Object.keys(js).length) o.js = js;
  return o;
}

function printList(title, items, colorFn, limit = 30) {
  if (!items.length) return;
  console.log(`\n${colorFn(`${title} (${items.length})`)}`);
  for (const i of items.slice(0, limit)) console.log(`  • ${i}`);
  if (items.length > limit) console.log(C.gray(`  … y ${items.length - limit} más (usa --json para verlos todos)`));
}

function jsonResult(result) {
  return {
    ok: true,
    version: result.version,
    root: result.root,
    outDir: result.outDir,
    durationMs: result.durationMs,
    pages: result.pages,
    outputs: result.report.rows,
    totals: result.report.totals,
    coverage: Object.fromEntries(result.coverage),
    ignored: result.ignored,
    broken: result.broken,
    workers: result.workers,
    standalone: result.standalone,
    dependencies: result.dependencies,
    vendor: result.vendor,
    warnings: result.warnings,
    notes: result.notes,
    verify: result.verify && { errors: result.verify.errors, stats: result.verify.stats },
    perf: result.perf,
  };
}

function printSummary(result, args) {
  const r = result.report;
  const counts = Object.entries(r.byType)
    .map(([t, v]) => `${v.files} ${t}`)
    .join(' · ');
  console.log(renderReport(r, C, { verbose: args.verbose }));
  console.log(`\n${C.green('✔')} ${counts}  ${C.gray(`(${(result.durationMs / 1000).toFixed(2)} s)`)}`);
  if (result.verify) {
    const s = result.verify.stats;
    console.log(`${C.green('✔')} Verificación: ${s.files} archivos escritos, ${s.refs} referencias comprobadas, ${s.js} JS válidos, 0 errores`);
  }
  console.log(`${C.green('✔')} Cobertura: ${result.coverage.size}/${result.coverage.size} archivos de origen con destino conocido`);
  if (r.compressed) console.log(`${C.green('✔')} ${r.compressed} archivos precomprimidos (.gz/.br)`);
  const p = result.perf;
  if (p?.tasks) {
    const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
    const where = p.threads ? `en el hilo principal y ${plural(p.threads, 'hilo', 'hilos')} más` : 'en el hilo principal';
    const all = p.cacheHits === p.tasks;
    const detail = all
      ? p.tasks === 1
        ? 'reutilizado de la caché'
        : 'todos reutilizados de la caché'
      : `${where}${p.cacheHits ? `, ${p.cacheHits} de la caché` : ''}`;
    console.log(`${C.green('✔')} Ofuscación/terser: ${plural(p.tasks, 'archivo', 'archivos')}, ${detail}`);
  }
  if (result.obfuscated) {
    const deps = [
      ...result.dependencies.map((d) => `${d.rel} — ${d.reason}`),
      ...result.vendor.map((v) => `${v} — paquete importado (archivo vendor aparte)`),
    ];
    if (deps.length) printList('Dependencias detectadas (no se ofuscan)', deps, C.cyan);
  }
  printList('Avisos', result.warnings, C.yellow);
  if (args.verbose) {
    printList('Notas', result.notes, C.cyan, 200);
    printList(
      'Excluidos',
      result.ignored.map((i) => `${i.rel} — ${i.reason}`),
      C.gray,
      200,
    );
  } else if (result.notes.length) console.log(C.gray(`\n${result.notes.length} nota(s) informativas: usa --verbose para verlas.`));
}

async function cmdBuild(dir, args) {
  const cfg = await loadConfig({ dir, config: args.config, overrides: overridesFrom(args) });
  const log = args.quiet || args.json ? () => {} : (m) => console.log(C.gray(`  ${m}`));
  if (!args.quiet && !args.json) console.log(`${C.bold(`Builder ${VERSION}`)}  ${cfg.root} ${C.gray('→')} ${cfg.outDir}`);
  const result = await runPipeline(cfg, { mode: 'build', force: !!args.force, keepFailed: !!args['keep-failed'], log });
  if (args.json) console.log(JSON.stringify(jsonResult(result), null, 2));
  else if (!args.quiet) printSummary(result, args);
  return result;
}

async function cmdAnalyze(dir, args) {
  const cfg = await loadConfig({ dir, config: args.config, overrides: overridesFrom(args) });
  const result = await runPipeline(cfg, { mode: 'analyze' });
  if (args.json) {
    console.log(JSON.stringify(jsonResult(result), null, 2));
    return;
  }
  console.log(`${C.bold(`Builder ${VERSION} — análisis`)}  ${cfg.root}\n`);
  console.log(`${C.bold('Páginas completas')}: ${result.pages.full.join(', ') || '—'}`);
  if (result.pages.conservative.length)
    console.log(`${C.bold('Modo conservador')} (fragmentos u otras codificaciones): ${result.pages.conservative.join(', ')}`);
  console.log(`\n${C.bold('Qué pasará con cada archivo del proyecto')}`);
  const rows = [...result.coverage.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  const w = Math.min(50, Math.max(...rows.map(([k]) => k.length), 10));
  for (const [rel, list] of rows) {
    const shown = args.verbose ? list : list.filter((s) => s !== `copiado → ${rel}`);
    if (!shown.length) continue;
    console.log(`  ${rel.padEnd(w)}  ${C.gray(shown.join(' | '))}`);
  }
  const copied = rows.filter(([rel, list]) => list.length === 1 && list[0] === `copiado → ${rel}`).length;
  if (copied && !args.verbose) console.log(C.gray(`  + ${copied} recursos que se copian sin cambios (--verbose para listarlos)`));
  const deps = [...result.dependencies.map((d) => `${d.rel} — ${d.reason}`)];
  printList('Dependencias de terceros detectadas (no se ofuscan)', deps, C.cyan);
  if (result.workers.length)
    printList(
      'Workers detectados',
      result.workers.map((wk) => `${wk.rel} (${wk.kind}${wk.module ? ', módulo' : ''}) desde ${wk.from}`),
      C.cyan,
    );
  printList(
    'Referencias rotas en el código fuente',
    result.broken.map((b) => `${b.from} → ${b.url} (${b.status})`),
    C.yellow,
  );
  printList('Avisos', result.warnings, C.yellow);
  printList(
    'Excluidos',
    result.ignored.map((i) => `${i.rel} — ${i.reason}`),
    C.gray,
    args.verbose ? 500 : 15,
  );
  if (args.verbose) printList('Notas', result.notes, C.cyan, 500);
  const t = result.report.totals;
  console.log(`\nSalida prevista: ${t.files} archivos, ${formatBytes(t.before)} → ${formatBytes(t.size)} (sin ofuscar). Nada se escribió.`);
}

async function cmdInit(dir, args) {
  const projectDir = path.resolve(dir);
  const existing = findConfigFile(projectDir);
  if (existing && !args.force) throw new BuildError(`Ya existe ${path.basename(existing)}. Usa --force para reemplazarlo.`);
  const cfg = await loadConfig({ dir, config: args.config, overrides: overridesFrom(args) });
  const result = await runPipeline(cfg, { mode: 'analyze' });
  const config = {
    outDir: relFrom(cfg.root, cfg.outDir) ?? cfg.outDir,
    entries: 'auto',
    include: [],
    ignore: [],
    unreferenced: 'process',
    obfuscate: false,
    dependencies: { detect: true, obfuscate: false, include: [], exclude: [] },
    hash: false,
    sourcemap: false,
    compress: false,
    js: { target: 'auto', minifier: 'esbuild', drop: [] },
  };
  const file = path.join(projectDir, 'builder.config.json');
  fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
  console.log(`${C.green('✔')} Creado ${file}`);
  console.log(`  Páginas detectadas: ${result.pages.full.join(', ') || '— (ninguna; define "entries")'}`);
  if (result.broken.length) console.log(C.yellow(`  Hay ${result.broken.length} referencia(s) rota(s) en el código; míralas con "builder analyze".`));
  if (result.dependencies.length)
    console.log(`  Librerías de terceros detectadas (no se ofuscarán): ${result.dependencies.map((d) => d.rel).join(', ')}`);
  console.log(C.gray('  Edita "include" para forzar archivos que solo se cargan desde JS, e "ignore" para excluir.'));
  console.log(C.gray('  En "dependencies.include" marcas a mano librerías; en "dependencies.exclude" corriges una detección.'));
}

/** builder deps [carpeta] — lista; builder deps add|own|reset <patrón…> — edita builder.config.json. */
async function cmdDeps(_dir, args) {
  const sub = args._[1];
  if (['add', 'own', 'reset'].includes(sub)) return editDeps(sub, args._.slice(2), args);
  const dir = args.dir ?? sub ?? '.';
  const cfg = await loadConfig({ dir, config: args.config, overrides: overridesFrom(args) });
  const result = await runPipeline(cfg, { mode: 'analyze' });
  const deps = new Map(result.dependencies.map((d) => [d.rel, d.reason]));
  const own = [...result.coverage.keys()].filter((rel) => JS_EXT.has(extOf(rel)) && !deps.has(rel)).sort();
  if (args.json) {
    console.log(JSON.stringify({ dependencies: result.dependencies, own }, null, 2));
    return;
  }
  console.log(`${C.bold(`Builder ${VERSION} — dependencias`)}  ${cfg.root}`);
  printList(
    'Librerías de terceros (no se ofuscan)',
    [...deps].map(([rel, why]) => `${rel} ${C.gray(`— ${why}`)}`),
    C.cyan,
    200,
  );
  printList('Tu código (se ofusca con --obfuscate)', own, C.green, 200);
  if (!deps.size && !own.length) console.log('\nNo hay archivos JavaScript en el proyecto.');
  console.log(C.gray('\n¿Algo mal clasificado?'));
  console.log(C.gray('  builder deps add <patrón>     es una librería: no se ofusca'));
  console.log(C.gray('  builder deps own <patrón>     es tu código: sí se ofusca'));
  console.log(C.gray('  builder deps reset <patrón>   vuelve a la detección automática'));
  console.log(C.gray('  También: data-builder="dependency" en el <script>, o /* @builder-dependency */ al inicio del archivo.'));
}

async function editDeps(sub, rawPatterns, args) {
  if (!rawPatterns.length) throw new BuildError(`Indica uno o más archivos o patrones: builder deps ${sub} "js/vendor/**"`);
  const projectDir = path.resolve(args.dir ?? '.');
  const file = args.config ? path.resolve(args.config) : (findConfigFile(projectDir) ?? path.join(projectDir, 'builder.config.json'));
  if (!file.endsWith('.json'))
    throw new BuildError(`La configuración está en ${path.basename(file)} (JavaScript); añade los patrones a mano en "dependencies".`);
  const config = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')) : {};
  if (config.dependencies === false || config.dependencies === true || config.dependencies == null) config.dependencies = {};
  const d = config.dependencies;
  const include = new Set(d.include ?? []);
  const exclude = new Set(d.exclude ?? []);
  const patterns = rawPatterns.map((p) => toPosix(p).replace(/^\.\//, ''));
  for (const p of patterns) {
    if (sub === 'add') {
      include.add(p);
      exclude.delete(p);
    } else if (sub === 'own') {
      exclude.add(p);
      include.delete(p);
    } else {
      include.delete(p);
      exclude.delete(p);
    }
  }
  d.include = [...include];
  d.exclude = [...exclude];
  // Se valida antes de escribir: nunca deja un builder.config.json roto.
  const cfg = await loadConfig({ dir: projectDir, config: args.config, overrides: { dependencies: { include: d.include, exclude: d.exclude } } });
  const existed = fs.existsSync(file);
  fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
  const result = await runPipeline(cfg, { mode: 'analyze' });
  const deps = new Map(result.dependencies.map((x) => [x.rel, x.reason]));
  const jsFiles = [...result.coverage.keys()].filter((rel) => JS_EXT.has(extOf(rel)));
  console.log(`${C.green('✔')} ${existed ? 'Actualizado' : 'Creado'} ${file}`);
  for (const p of patterns) {
    const hits = jsFiles.filter(globMatcher([p]));
    if (!hits.length) {
      console.log(C.yellow(`  ! "${p}" no coincide con ningún archivo JavaScript del proyecto (queda guardado igualmente)`));
      continue;
    }
    for (const rel of hits) console.log(`  ${rel}  ${deps.has(rel) ? C.cyan(`librería — ${deps.get(rel)}`) : C.green('tu código — se ofusca')}`);
  }
}

async function cmdServe(dir, args) {
  const cfg = await loadConfig({ dir, config: args.config, overrides: overridesFrom(args) });
  const target = fs.existsSync(cfg.outDir) ? cfg.outDir : null;
  if (!target) throw new BuildError(`No existe ${cfg.outDir}. Ejecuta primero "builder build".`);
  const srv = await startServer({ dir: target, port: Number(args.port ?? 5173), host: args.host ?? '127.0.0.1' });
  console.log(`${C.green('✔')} Sirviendo ${target} en ${C.bold(srv.url)}  ${C.gray('(Ctrl+C para salir)')}`);
  if (args.open) openBrowser(srv.url);
}

async function cmdDev(dir, args) {
  const cfg = await loadConfig({ dir, config: args.config, overrides: overridesFrom(args) });
  let srv = null;
  let running = false;
  let pending = false;
  const rebuild = async (reason) => {
    if (running) {
      pending = true;
      return;
    }
    running = true;
    const t = Date.now();
    try {
      const fresh = await loadConfig({ dir, config: args.config, overrides: overridesFrom(args) });
      const result = await runPipeline(fresh, { mode: 'build', force: !!args.force });
      console.log(
        `${C.green('✔')} ${reason ? `${reason} → ` : ''}compilado en ${Date.now() - t} ms${result.warnings.length ? C.yellow(` (${result.warnings.length} avisos)`) : ''}`,
      );
      for (const w of result.warnings.slice(0, 5)) console.log(C.yellow(`  • ${w}`));
      srv?.buildOk();
      srv?.reload();
    } catch (err) {
      console.error(C.red(`✖ ${err.message}`));
      for (const d of err.details ?? []) console.error(C.red(`  • ${d}`));
      srv?.buildError([err.message, ...(err.details ?? [])].join('\n'));
    } finally {
      running = false;
      if (pending) {
        pending = false;
        rebuild('cambios pendientes');
      }
    }
  };
  await rebuild();
  fs.mkdirSync(cfg.outDir, { recursive: true });
  srv = await startServer({ dir: cfg.outDir, port: Number(args.port ?? 5173), host: args.host ?? '127.0.0.1', liveReload: true });
  console.log(`${C.green('✔')} Sirviendo ${cfg.outDir} en ${C.bold(srv.url)} con recarga automática  ${C.gray('(Ctrl+C para salir)')}`);
  if (args.open) openBrowser(srv.url);
  let timer = null;
  const changed = new Set();
  const outDir = path.resolve(cfg.outDir);
  const ignore = (rel) => {
    const abs = path.join(cfg.root, rel);
    return abs === outDir || isInside(outDir, abs) || /(^|\/)(node_modules|\.git)(\/|$)|\.builder-(tmp|old)-/.test(rel);
  };
  watchTree(cfg.root, ignore, (rel) => {
    changed.add(rel);
    clearTimeout(timer);
    timer = setTimeout(() => {
      const list = [...changed];
      changed.clear();
      rebuild(list.length === 1 ? list[0] : `${list.length} archivos`);
    }, 150);
  });
}

function openBrowser(url) {
  const cmd = process.platform === 'win32' ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const argv = process.platform === 'win32' ? ['/c', 'start', '""', url] : [url];
  spawn(cmd, argv, { detached: true, stdio: 'ignore' }).unref();
}

async function main() {
  const argv = process.argv.slice(2);
  const args = parseArgs(argv);
  if (args.version || args.v) return console.log(VERSION);
  const [command = 'help', dir = '.'] = args._;
  if (args.help || args.h || command === 'help') return console.log(HELP);
  const commands = { build: cmdBuild, analyze: cmdAnalyze, init: cmdInit, serve: cmdServe, dev: cmdDev, deps: cmdDeps };
  if (!commands[command]) throw new BuildError(`Comando desconocido "${command}". Usa "builder help".`);
  await commands[command](dir, args);
}

main().catch((err) => {
  const json = process.argv.includes('--json');
  if (json) {
    console.log(JSON.stringify({ ok: false, error: err.message, details: err.details ?? [] }, null, 2));
  } else {
    console.error(C.red(`✖ ${err.message}`));
    for (const d of err.details ?? []) console.error(C.red(`  • ${d}`));
    if (!(err instanceof BuildError)) console.error(C.gray(err.stack));
  }
  process.exitCode = err instanceof BuildError ? 1 : 2;
});
