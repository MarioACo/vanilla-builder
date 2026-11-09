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
import { L, setLang } from '../src/i18n.js';

const tty = process.stdout.isTTY && !process.env.NO_COLOR;
const color = (code) => (text) => (tty ? `\x1b[${code}m${text}\x1b[0m` : String(text));
const C = { red: color(31), yellow: color(33), green: color(32), blue: color(34), gray: color(90), bold: color(1), cyan: color(36) };

const help = () =>
  L(
    `Builder ${VERSION} — empaqueta, minifica y ofusca proyectos web vanilla (HTML, CSS y JS)

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
  --images                 Optimiza PNG (sin pérdida) y JPEG/WebP (calidad 80) con sharp
  --image-quality <1-100>  Calidad de JPEG/WebP con --images (por defecto 80)
  --browsers <consulta>    Navegadores objetivo (browserslist), ej. "> 0.5%, not dead"; --no-browsers los ignora
  --lang <en|es>           Idioma de los mensajes (por defecto: el del sistema; o BUILDER_LANG)
`,
    `Builder ${VERSION} — bundle, minify and obfuscate vanilla web projects (HTML, CSS and JS)

Usage:
  builder build   [folder] [options]     Build the project into dist/ (default)
  builder analyze [folder] [--json]      Show detected dependencies and the planned output, without writing
  builder init    [folder] [--force]     Create builder.config.json from what was detected
  builder deps    [folder]               List which JS files are third-party libraries (not obfuscated) and which are yours
  builder deps add|own|reset <pattern…>  Mark libraries (add), your code (own) or back to automatic (reset)
  builder dev     [folder] [--port N]    Build, watch for changes and serve dist/ with live reload
  builder serve   [folder] [--port N]    Serve the output folder to try it

Mark dependencies without configuration:
  In the HTML:       <script src="js/lib.js" data-builder="dependency"></script>   (or "own")
  In the file:       /* @builder-dependency */  at the top                         (or @builder-own)
  With deps:         builder deps add "js/libs/**"   (another folder: --dir <folder>)

Build options:
  --out <folder>           Output folder (default dist)
  --config <file>          Configuration file (default builder.config.json)
  --entry <file>           Explicit entry (repeatable). Default: every complete .html
  --include <pattern>      Always include files (repeatable), e.g. "data/**"
  --ignore <pattern>       Exclude files (repeatable), e.g. "drafts/**"
  --obfuscate [level]      Obfuscate your JS: low | medium | high | max (default medium)
                           Third-party libraries are detected and NOT obfuscated.
  --dep <pattern>          Mark files as a dependency by hand (not obfuscated), repeatable
  --not-dep <pattern>      Correct the detection: that file is yours and is obfuscated, repeatable
  --obfuscate-deps         Obfuscate dependencies too
  --minifier terser        Maximum JS compression with a second terser pass
  --compress [gzip|brotli] Also write precompressed .gz and .br files (both by default)
  --hash                   Hashed JS/CSS file names (long-term caching)
  --sourcemap [mode]       Generate source maps (linked | hidden | inline)
  --target <target>        Output browsers/ES level, e.g. es2018 (default: your own code's level)
  --drop-console           Remove console.* and debugger
  --no-minify              Do not minify (useful for debugging)
  --no-merge               Do not merge consecutive classic scripts
  --unreferenced <mode>    Unreferenced files: process | copy | skip (default process)
  --base <path>            Site base path for absolute URLs (default /)
  --workers <n|auto>       Threads for obfuscation/compression (0 = none; default auto)
  --no-cache               Do not use the cache from previous builds
  --no-verify              Skip the final verification (not recommended)
  --force                  Allow emptying an output folder Builder did not create
  --keep-failed            Keep the temporary folder if verification fails
  --json                   JSON result (for CI)
  --verbose                Show notes, copied and excluded files
  --quiet                  Errors only
  --images                 Optimize PNG (lossless) and JPEG/WebP (quality 80) with sharp
  --image-quality <1-100>  JPEG/WebP quality with --images (default 80)
  --browsers <query>       Target browsers (browserslist), e.g. "> 0.5%, not dead"; --no-browsers ignores them
  --lang <en|es>           Message language (default: system language; or BUILDER_LANG)
`,
  );

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
    'lang',
    'browsers',
    'image-quality',
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
      if (val === undefined) throw new BuildError(L(`Falta el valor de --${key}.`, `Missing value for --${key}.`));
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
  if (args['image-quality'] !== undefined) {
    const q = Number(args['image-quality']);
    if (!(Number.isInteger(q) && q >= 1 && q <= 100))
      throw new BuildError(L('--image-quality debe ser un número entre 1 y 100.', '--image-quality must be a number between 1 and 100.'));
    o.images = { quality: q };
  } else if (args.images !== undefined) o.images = !!args.images;
  if (args.browsers === false) o.browsers = false;
  else if (typeof args.browsers === 'string') o.browsers = args.browsers;
  if (args.workers !== undefined) {
    const n = Number(args.workers);
    if (args.workers !== 'auto' && !(Number.isInteger(n) && n >= 0))
      throw new BuildError(L('--workers debe ser "auto" o un número (0 = sin hilos).', '--workers must be "auto" or a number (0 = no threads).'));
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
  if (items.length > limit)
    console.log(
      C.gray(
        L(`  … y ${items.length - limit} más (usa --json para verlos todos)`, `  … and ${items.length - limit} more (use --json to see them all)`),
      ),
    );
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
    console.log(
      L(
        `${C.green('✔')} Verificación: ${s.files} archivos escritos, ${s.refs} referencias comprobadas, ${s.js} JS válidos, 0 errores`,
        `${C.green('✔')} Verification: ${s.files} files written, ${s.refs} references checked, ${s.js} valid JS, 0 errors`,
      ),
    );
  }
  console.log(
    L(
      `${C.green('✔')} Cobertura: ${result.coverage.size}/${result.coverage.size} archivos de origen con destino conocido`,
      `${C.green('✔')} Coverage: ${result.coverage.size}/${result.coverage.size} source files with a known destination`,
    ),
  );
  if (r.compressed)
    console.log(
      L(`${C.green('✔')} ${r.compressed} archivos precomprimidos (.gz/.br)`, `${C.green('✔')} ${r.compressed} precompressed files (.gz/.br)`),
    );
  const p = result.perf;
  if (p?.tasks) {
    const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
    const where = p.threads
      ? L(
          `en el hilo principal y ${plural(p.threads, 'hilo', 'hilos')} más`,
          `on the main thread and ${plural(p.threads, 'more thread', 'more threads')}`,
        )
      : L('en el hilo principal', 'on the main thread');
    const all = p.cacheHits === p.tasks;
    const detail = all
      ? p.tasks === 1
        ? L('reutilizado de la caché', 'reused from the cache')
        : L('todos reutilizados de la caché', 'all reused from the cache')
      : L(`${where}${p.cacheHits ? `, ${p.cacheHits} de la caché` : ''}`, `${where}${p.cacheHits ? `, ${p.cacheHits} from the cache` : ''}`);
    console.log(
      L(
        `${C.green('✔')} Ofuscación/terser: ${plural(p.tasks, 'archivo', 'archivos')}, ${detail}`,
        `${C.green('✔')} Obfuscation/terser: ${plural(p.tasks, 'file', 'files')}, ${detail}`,
      ),
    );
  }
  if (result.obfuscated) {
    const deps = [
      ...result.dependencies.map((d) => `${d.rel} — ${d.reason}`),
      ...result.vendor.map((v) => L(`${v} — paquete importado (archivo vendor aparte)`, `${v} — imported package (separate vendor file)`)),
    ];
    if (deps.length) printList(L('Dependencias detectadas (no se ofuscan)', 'Detected dependencies (not obfuscated)'), deps, C.cyan);
  }
  printList(L('Avisos', 'Warnings'), result.warnings, C.yellow);
  if (args.verbose) {
    printList(L('Notas', 'Notes'), result.notes, C.cyan, 200);
    printList(
      L('Excluidos', 'Excluded'),
      result.ignored.map((i) => `${i.rel} — ${i.reason}`),
      C.gray,
      200,
    );
  } else if (result.notes.length)
    console.log(
      C.gray(
        L(
          `\n${result.notes.length} nota(s) informativas: usa --verbose para verlas.`,
          `\n${result.notes.length} informational note(s): use --verbose to see them.`,
        ),
      ),
    );
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
  console.log(L(`${C.bold(`Builder ${VERSION} — análisis`)}  ${cfg.root}\n`, `${C.bold(`Builder ${VERSION} — analysis`)}  ${cfg.root}\n`));
  console.log(
    L(
      `${C.bold('Páginas completas')}: ${result.pages.full.join(', ') || '—'}`,
      `${C.bold('Complete pages')}: ${result.pages.full.join(', ') || '—'}`,
    ),
  );
  if (result.pages.conservative.length)
    console.log(`${C.bold('Modo conservador')} (fragmentos u otras codificaciones): ${result.pages.conservative.join(', ')}`);
  console.log(L(`\n${C.bold('Qué pasará con cada archivo del proyecto')}`, `\n${C.bold('What will happen to each project file')}`));
  const rows = [...result.coverage.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  const w = Math.min(50, Math.max(...rows.map(([k]) => k.length), 10));
  for (const [rel, list] of rows) {
    const shown = args.verbose ? list : list.filter((s) => s !== `${L('copiado', 'copied')} → ${rel}`);
    if (!shown.length) continue;
    console.log(`  ${rel.padEnd(w)}  ${C.gray(shown.join(' | '))}`);
  }
  const copied = rows.filter(([rel, list]) => list.length === 1 && list[0] === `${L('copiado', 'copied')} → ${rel}`).length;
  if (copied && !args.verbose)
    console.log(
      C.gray(
        L(
          `  + ${copied} recursos que se copian sin cambios (--verbose para listarlos)`,
          `  + ${copied} assets copied unchanged (--verbose to list them)`,
        ),
      ),
    );
  const deps = [...result.dependencies.map((d) => `${d.rel} — ${d.reason}`)];
  printList(L('Dependencias de terceros detectadas (no se ofuscan)', 'Detected third-party dependencies (not obfuscated)'), deps, C.cyan);
  if (result.workers.length)
    printList(
      L('Workers detectados', 'Detected workers'),
      result.workers.map((wk) =>
        L(
          `${wk.rel} (${wk.kind}${wk.module ? ', módulo' : ''}) desde ${wk.from}`,
          `${wk.rel} (${wk.kind}${wk.module ? ', module' : ''}) from ${wk.from}`,
        ),
      ),
      C.cyan,
    );
  printList(
    L('Referencias rotas en el código fuente', 'Broken references in the source code'),
    result.broken.map((b) => `${b.from} → ${b.url} (${b.status})`),
    C.yellow,
  );
  printList(L('Avisos', 'Warnings'), result.warnings, C.yellow);
  printList(
    L('Excluidos', 'Excluded'),
    result.ignored.map((i) => `${i.rel} — ${i.reason}`),
    C.gray,
    args.verbose ? 500 : 15,
  );
  if (args.verbose) printList(L('Notas', 'Notes'), result.notes, C.cyan, 500);
  const t = result.report.totals;
  console.log(
    L(
      `\nSalida prevista: ${t.files} archivos, ${formatBytes(t.before)} → ${formatBytes(t.size)} (sin ofuscar). Nada se escribió.`,
      `\nPlanned output: ${t.files} files, ${formatBytes(t.before)} → ${formatBytes(t.size)} (not obfuscated). Nothing was written.`,
    ),
  );
}

async function cmdInit(dir, args) {
  const projectDir = path.resolve(dir);
  const existing = findConfigFile(projectDir);
  if (existing && !args.force)
    throw new BuildError(
      L(
        `Ya existe ${path.basename(existing)}. Usa --force para reemplazarlo.`,
        `${path.basename(existing)} already exists. Use --force to replace it.`,
      ),
    );
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
  console.log(
    L(
      `  Páginas detectadas: ${result.pages.full.join(', ') || '— (ninguna; define "entries")'}`,
      `  Detected pages: ${result.pages.full.join(', ') || '— (none; set "entries")'}`,
    ),
  );
  if (result.broken.length)
    console.log(
      C.yellow(
        L(
          `  Hay ${result.broken.length} referencia(s) rota(s) en el código; míralas con "builder analyze".`,
          `  There are ${result.broken.length} broken reference(s) in the code; see them with "builder analyze".`,
        ),
      ),
    );
  if (result.dependencies.length)
    console.log(
      L(
        `  Librerías de terceros detectadas (no se ofuscarán): ${result.dependencies.map((d) => d.rel).join(', ')}`,
        `  Detected third-party libraries (will not be obfuscated): ${result.dependencies.map((d) => d.rel).join(', ')}`,
      ),
    );
  console.log(
    C.gray(
      L(
        '  Edita "include" para forzar archivos que solo se cargan desde JS, e "ignore" para excluir.',
        '  Edit "include" to force files that are only loaded from JS, and "ignore" to exclude.',
      ),
    ),
  );
  console.log(
    C.gray(
      L(
        '  En "dependencies.include" marcas a mano librerías; en "dependencies.exclude" corriges una detección.',
        '  In "dependencies.include" you mark libraries by hand; in "dependencies.exclude" you correct a detection.',
      ),
    ),
  );
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
  console.log(`${C.bold(`Builder ${VERSION} — ${L('dependencias', 'dependencies')}`)}  ${cfg.root}`);
  printList(
    L('Librerías de terceros (no se ofuscan)', 'Third-party libraries (not obfuscated)'),
    [...deps].map(([rel, why]) => `${rel} ${C.gray(`— ${why}`)}`),
    C.cyan,
    200,
  );
  printList(L('Tu código (se ofusca con --obfuscate)', 'Your code (obfuscated with --obfuscate)'), own, C.green, 200);
  if (!deps.size && !own.length) console.log(L('\nNo hay archivos JavaScript en el proyecto.', '\nThere are no JavaScript files in the project.'));
  console.log(C.gray(L('\n¿Algo mal clasificado?', '\nSomething classified wrong?')));
  console.log(
    C.gray(L('  builder deps add <patrón>     es una librería: no se ofusca', '  builder deps add <pattern>     it is a library: not obfuscated')),
  );
  console.log(
    C.gray(L('  builder deps own <patrón>     es tu código: sí se ofusca', '  builder deps own <pattern>     it is your code: obfuscated')),
  );
  console.log(
    C.gray(L('  builder deps reset <patrón>   vuelve a la detección automática', '  builder deps reset <pattern>   back to automatic detection')),
  );
  console.log(
    C.gray(
      L(
        '  También: data-builder="dependency" en el <script>, o /* @builder-dependency */ al inicio del archivo.',
        '  Also: data-builder="dependency" on the <script>, or /* @builder-dependency */ at the top of the file.',
      ),
    ),
  );
}

async function editDeps(sub, rawPatterns, args) {
  if (!rawPatterns.length)
    throw new BuildError(
      L(
        `Indica uno o más archivos o patrones: builder deps ${sub} "js/vendor/**"`,
        `Give one or more files or patterns: builder deps ${sub} "js/vendor/**"`,
      ),
    );
  const projectDir = path.resolve(args.dir ?? '.');
  const file = args.config ? path.resolve(args.config) : (findConfigFile(projectDir) ?? path.join(projectDir, 'builder.config.json'));
  if (!file.endsWith('.json'))
    throw new BuildError(
      L(
        `La configuración está en ${path.basename(file)} (JavaScript); añade los patrones a mano en "dependencies".`,
        `The configuration is in ${path.basename(file)} (JavaScript); add the patterns to "dependencies" by hand.`,
      ),
    );
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
      console.log(
        C.yellow(
          L(
            `  ! "${p}" no coincide con ningún archivo JavaScript del proyecto (queda guardado igualmente)`,
            `  ! "${p}" does not match any JavaScript file in the project (saved anyway)`,
          ),
        ),
      );
      continue;
    }
    for (const rel of hits)
      console.log(
        L(
          `  ${rel}  ${deps.has(rel) ? C.cyan(`librería — ${deps.get(rel)}`) : C.green('tu código — se ofusca')}`,
          `  ${rel}  ${deps.has(rel) ? C.cyan(`library — ${deps.get(rel)}`) : C.green('your code — obfuscated')}`,
        ),
      );
  }
}

async function cmdServe(dir, args) {
  const cfg = await loadConfig({ dir, config: args.config, overrides: overridesFrom(args) });
  const target = fs.existsSync(cfg.outDir) ? cfg.outDir : null;
  if (!target)
    throw new BuildError(L(`No existe ${cfg.outDir}. Ejecuta primero "builder build".`, `${cfg.outDir} does not exist. Run "builder build" first.`));
  const srv = await startServer({ dir: target, port: Number(args.port ?? 5173), host: args.host ?? '127.0.0.1' });
  console.log(
    L(
      `${C.green('✔')} Sirviendo ${target} en ${C.bold(srv.url)}  ${C.gray('(Ctrl+C para salir)')}`,
      `${C.green('✔')} Serving ${target} at ${C.bold(srv.url)}  ${C.gray('(Ctrl+C to quit)')}`,
    ),
  );
  if (args.open) openBrowser(srv.url);
}

async function cmdDev(dir, args) {
  const cfg = await loadConfig({ dir, config: args.config, overrides: overridesFrom(args) });
  let srv = null;
  let running = false;
  let pending = false;
  // files: archivos que cambiaron; si todos son CSS (y sin hash), basta con recargar las hojas de estilos.
  let pendingFiles = [];
  const rebuild = async (reason, files = null) => {
    if (running) {
      pending = true;
      pendingFiles = files && pendingFiles ? [...pendingFiles, ...files] : null;
      return;
    }
    running = true;
    const t = Date.now();
    try {
      const fresh = await loadConfig({ dir, config: args.config, overrides: overridesFrom(args) });
      const result = await runPipeline(fresh, { mode: 'build', force: !!args.force });
      console.log(
        `${C.green('✔')} ${reason ? `${reason} → ` : ''}${L('compilado en', 'built in')} ${Date.now() - t} ms${result.warnings.length ? C.yellow(L(` (${result.warnings.length} avisos)`, ` (${result.warnings.length} warnings)`)) : ''}`,
      );
      for (const w of result.warnings.slice(0, 5)) console.log(C.yellow(`  • ${w}`));
      srv?.buildOk();
      const cssOnly = files?.length && !fresh.hash && files.every((f) => /\.css$/i.test(f));
      if (cssOnly) srv?.reloadCss();
      else srv?.reload();
    } catch (err) {
      console.error(C.red(`✖ ${err.message}`));
      for (const d of err.details ?? []) console.error(C.red(`  • ${d}`));
      srv?.buildError([err.message, ...(err.details ?? [])].join('\n'));
    } finally {
      running = false;
      if (pending) {
        pending = false;
        const next = pendingFiles;
        pendingFiles = [];
        rebuild(L('cambios pendientes', 'pending changes'), next);
      }
    }
  };
  await rebuild();
  fs.mkdirSync(cfg.outDir, { recursive: true });
  srv = await startServer({ dir: cfg.outDir, port: Number(args.port ?? 5173), host: args.host ?? '127.0.0.1', liveReload: true });
  console.log(
    L(
      `${C.green('✔')} Sirviendo ${cfg.outDir} en ${C.bold(srv.url)} con recarga automática  ${C.gray('(Ctrl+C para salir)')}`,
      `${C.green('✔')} Serving ${cfg.outDir} at ${C.bold(srv.url)} with live reload  ${C.gray('(Ctrl+C to quit)')}`,
    ),
  );
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
      rebuild(list.length === 1 ? list[0] : L(`${list.length} archivos`, `${list.length} files`), list);
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
  // El idioma se fija antes que nada para que todos los mensajes salgan en él.
  const langAt = argv.findIndex((a) => a === '--lang' || a.startsWith('--lang='));
  if (langAt > -1) setLang(argv[langAt].includes('=') ? argv[langAt].split('=')[1] : argv[langAt + 1]);
  const args = parseArgs(argv);
  if (args.version || args.v) return console.log(VERSION);
  const [command = 'help', dir = '.'] = args._;
  if (args.help || args.h || command === 'help') return console.log(help());
  const commands = { build: cmdBuild, analyze: cmdAnalyze, init: cmdInit, serve: cmdServe, dev: cmdDev, deps: cmdDeps };
  if (!commands[command])
    throw new BuildError(L(`Comando desconocido "${command}". Usa "builder help".`, `Unknown command "${command}". Use "builder help".`));
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
