#!/usr/bin/env node
// Línea de comandos de Builder: build, analyze, init, dev y serve.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { loadConfig, findConfigFile } from '../src/config.js';
import { runPipeline, VERSION } from '../src/builder.js';
import { renderReport } from '../src/report.js';
import { startServer } from '../src/server.js';
import { BuildError, formatBytes, relFrom, isInside } from '../src/util.js';

const tty = process.stdout.isTTY && !process.env.NO_COLOR;
const color = (code) => (text) => (tty ? `\x1b[${code}m${text}\x1b[0m` : String(text));
const C = { red: color(31), yellow: color(33), green: color(32), blue: color(34), gray: color(90), bold: color(1), cyan: color(36) };

const HELP = `Builder ${VERSION} — empaqueta, minifica y ofusca proyectos web vanilla (HTML, CSS y JS)

Uso:
  builder build   [carpeta] [opciones]   Compila el proyecto en dist/ (por defecto)
  builder analyze [carpeta] [--json]     Muestra dependencias detectadas y la salida prevista, sin escribir
  builder init    [carpeta] [--force]    Crea builder.config.json con lo detectado
  builder dev     [carpeta] [--port N]   Compila, vigila cambios y sirve dist/ con recarga automática
  builder serve   [carpeta] [--port N]   Sirve la carpeta de salida para probarla

Opciones de build:
  --out <carpeta>          Carpeta de salida (por defecto dist)
  --config <archivo>       Archivo de configuración (por defecto builder.config.json)
  --entry <archivo>        Entrada explícita (repetible). Por defecto: todos los .html completos
  --include <patrón>       Fuerza incluir archivos (repetible), ej. "data/**"
  --ignore <patrón>        Excluye archivos (repetible), ej. "borradores/**"
  --obfuscate [nivel]      Ofusca el JS: low | medium | high (por defecto medium)
  --hash                   Nombres con hash en JS/CSS (caché a largo plazo)
  --sourcemap [modo]       Genera source maps (linked | hidden | inline)
  --target <target>        Navegadores/ES de salida, ej. es2018 (por defecto: el del propio código)
  --drop-console           Quita console.* y debugger
  --no-minify              No minifica (útil para depurar)
  --no-merge               No une scripts clásicos consecutivos
  --unreferenced <modo>    Archivos no referenciados: process | copy | skip (por defecto process)
  --base <ruta>            Ruta base del sitio para URLs absolutas (por defecto /)
  --no-verify              Omite la verificación final (no recomendado)
  --force                  Permite vaciar una carpeta de salida que no creó Builder
  --keep-failed            Conserva la carpeta temporal si la verificación falla
  --json                   Resultado en JSON (para CI)
  --verbose                Muestra notas, archivos copiados y excluidos
  --quiet                  Solo errores
`;

function parseArgs(argv) {
  const args = { _: [], entry: [], include: [], ignore: [] };
  const takesValue = new Set(['out', 'config', 'entry', 'include', 'ignore', 'target', 'unreferenced', 'base', 'port', 'host']);
  const optionalValue = { obfuscate: ['low', 'medium', 'high'], sourcemap: ['linked', 'hidden', 'inline'] };
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
  const js = {};
  if (args.target) js.target = args.target;
  if (args['drop-console']) js.drop = ['console', 'debugger'];
  if (args.merge === false) js.mergeClassic = false;
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
    warnings: result.warnings,
    notes: result.notes,
    verify: result.verify && { errors: result.verify.errors, stats: result.verify.stats },
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
  printList('Avisos', result.warnings, C.yellow);
  if (args.verbose) {
    printList('Notas', result.notes, C.cyan, 200);
    printList('Excluidos', result.ignored.map((i) => `${i.rel} — ${i.reason}`), C.gray, 200);
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
  if (result.pages.conservative.length) console.log(`${C.bold('Modo conservador')} (fragmentos u otras codificaciones): ${result.pages.conservative.join(', ')}`);
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
  if (result.workers.length) printList('Workers detectados', result.workers.map((wk) => `${wk.rel} (${wk.kind}${wk.module ? ', módulo' : ''}) desde ${wk.from}`), C.cyan);
  printList('Referencias rotas en el código fuente', result.broken.map((b) => `${b.from} → ${b.url} (${b.status})`), C.yellow);
  printList('Avisos', result.warnings, C.yellow);
  printList('Excluidos', result.ignored.map((i) => `${i.rel} — ${i.reason}`), C.gray, args.verbose ? 500 : 15);
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
    hash: false,
    sourcemap: false,
    js: { target: 'auto', drop: [] },
  };
  const file = path.join(projectDir, 'builder.config.json');
  fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
  console.log(`${C.green('✔')} Creado ${file}`);
  console.log(`  Páginas detectadas: ${result.pages.full.join(', ') || '— (ninguna; define "entries")'}`);
  if (result.broken.length) console.log(C.yellow(`  Hay ${result.broken.length} referencia(s) rota(s) en el código; míralas con "builder analyze".`));
  console.log(C.gray('  Edita "include" para forzar archivos que solo se cargan desde JS, e "ignore" para excluir.'));
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
      console.log(`${C.green('✔')} ${reason ? `${reason} → ` : ''}compilado en ${Date.now() - t} ms${result.warnings.length ? C.yellow(` (${result.warnings.length} avisos)`) : ''}`);
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
  fs.watch(cfg.root, { recursive: true }, (_event, name) => {
    if (!name) return;
    const abs = path.join(cfg.root, name);
    if (abs === outDir || isInside(outDir, abs) || /(^|[\\/])(node_modules|\.git)([\\/]|$)|\.builder-(tmp|old)-/.test(name)) return;
    changed.add(name.split(path.sep).join('/'));
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
  const commands = { build: cmdBuild, analyze: cmdAnalyze, init: cmdInit, serve: cmdServe, dev: cmdDev };
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
