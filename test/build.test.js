// Pruebas de integración: compilan proyectos pequeños y comprueban las garantías del builder.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tempDir, writeFiles, read, exists, buildDir, copyFixture } from './helpers.js';
import { analyze } from '../src/index.js';
import { analyzeJs } from '../src/jsinfo.js';
import { sri, listFiles } from '../src/util.js';
import { verifyOutput } from '../src/verify.js';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../bin/builder.js', import.meta.url));
const cli = (cwd, ...args) => spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } });

const page = (body, head = '') => `<!doctype html><html><head><meta charset="utf-8">${head}</head><body>${body}</body></html>`;
const scriptsIn = (html) => [...html.matchAll(/<script[^>]*src="?([^" >]+)/g)].map((m) => m[1]);
// Las comillas se quitan cuando el estándar lo permite: las pruebas comparan sin ellas.
const unquote = (html) => html.replace(/="([^" \t\n'`=<>]+)"/g, '=$1');

test('no borra una carpeta de salida que no creó Builder', async () => {
  const dir = tempDir();
  writeFiles(dir, { 'index.html': page('hola'), 'dist/importante.txt': 'no me borres' });
  await assert.rejects(buildDir(dir), /no la creó Builder/);
  assert.equal(read(dir, 'dist/importante.txt'), 'no me borres');
  await buildDir(dir, {}, { force: true });
  assert.ok(!exists(dir, 'dist/importante.txt'));
  // Una segunda compilación sobre su propia salida no necesita --force.
  await buildDir(dir);
  assert.ok(exists(dir, 'dist/.builder-manifest.json'));
});

test('compila un proyecto abierto a través de un enlace simbólico (macOS /tmp, junctions)', async () => {
  const real = tempDir();
  writeFiles(real, {
    'site/index.html': page('<script type="module" src="js/main.js"></script><script type="module" src="js/admin.js"></script>'),
    'site/js/main.js': "import { n } from './shared.js';\nconsole.log('main', n);\n",
    'site/js/admin.js': "import { n } from './shared.js';\nconsole.log('admin', n);\n",
    'site/js/shared.js': 'export const n = 1;\n',
  });
  const via = path.join(tempDir(), 'via');
  fs.symlinkSync(real, via, 'junction');
  await buildDir(path.join(via, 'site'));
  assert.ok(exists(real, 'site/dist/js/main.js'));
  assert.ok(exists(real, 'site/dist/js/admin.js'));
});

test('hilos y caché: la salida es idéntica byte a byte y la caché se reutiliza', async () => {
  const snapshot = (r) => new Map([...r.outputs].map(([k, o]) => [k, o.copyFrom ? fs.readFileSync(o.copyFrom) : o.data]));
  const same = (a, b) => {
    assert.deepEqual([...a.keys()].sort(), [...b.keys()].sort());
    for (const [k, v] of a) assert.ok(v.equals(b.get(k)), `cambia ${k}`);
  };
  const prev = process.env.BUILDER_CACHE_DIR;
  process.env.BUILDER_CACHE_DIR = tempDir();
  try {
    for (const fixture of ['classic', 'modules']) {
      const opts = { obfuscate: 'medium', js: { minifier: 'terser' } };
      const serial = snapshot(await buildDir(copyFixture(fixture), { ...opts, workers: 0, cache: false }));
      const first = await buildDir(copyFixture(fixture), { ...opts, workers: 3, cache: true });
      same(serial, snapshot(first));
      assert.ok(first.perf.tasks > 0);
      const second = await buildDir(copyFixture(fixture), { ...opts, workers: 3, cache: true });
      same(serial, snapshot(second));
      assert.equal(second.perf.cacheHits, second.perf.tasks, 'la segunda compilación sale entera de la caché');
    }
  } finally {
    if (prev === undefined) delete process.env.BUILDER_CACHE_DIR;
    else process.env.BUILDER_CACHE_DIR = prev;
  }
});

test('rechaza outDir peligrosos', async () => {
  const dir = tempDir();
  writeFiles(dir, { 'index.html': page('x') });
  await assert.rejects(buildDir(dir, { outDir: '.' }), /propia carpeta del proyecto/);
  await assert.rejects(buildDir(dir, { outDir: '..' }), /contiene al proyecto/);
});

test('no publica secretos ni archivos de desarrollo', async () => {
  const dir = tempDir();
  writeFiles(dir, {
    'index.html': page('x'),
    '.env': 'CLAVE=1',
    '.env.production': 'CLAVE=2',
    'certs/server.key': 'k',
    'package.json': '{}',
    'node_modules/lib/index.js': 'x',
    '.htaccess': 'Options -Indexes',
  });
  const r = await buildDir(dir);
  for (const f of ['.env', '.env.production', 'certs/server.key', 'package.json', 'node_modules/lib/index.js'])
    assert.ok(!exists(dir, `dist/${f}`), f);
  assert.ok(exists(dir, 'dist/.htaccess'), '.htaccess sí se publica');
  assert.ok(r.ignored.some((i) => i.rel === '.env' && /secreto/.test(i.reason)));
});

test('une scripts clásicos solo cuando es seguro', async () => {
  const dir = tempDir();
  writeFiles(dir, {
    'index.html': page(
      [
        '<script src="a.js"></script>',
        '<script src="b.js"></script>', // se une con a
        '<script src="estricto.js"></script>', // modo estricto distinto
        '<script src="c.js"></script><script src="c2.js"></script>', // c2 redeclara un let de c
        '<script src="actual.js"></script>', // usa document.currentScript
        '<script src="d.js" async></script>',
        '<p>separador</p>',
        '<script src="e.js"></script>',
        '<div></div>',
        '<script src="f.js"></script>',
      ].join('\n'),
    ),
    'a.js': 'var a = 1',
    'b.js': '(function(){ window.b = a + 1 })()',
    'estricto.js': '"use strict"; var s = 1;',
    'c.js': 'let compartido = 1;',
    'c2.js': 'let compartido = 2;',
    'actual.js': 'window.x = document.currentScript.src;',
    'd.js': 'var d = 1;',
    'e.js': 'var e = 1;',
    'f.js': 'var f = 1;',
  });
  const r = await buildDir(dir);
  const html = read(dir, 'dist/index.html');
  const srcs = scriptsIn(html);
  assert.match(srcs[0], /^assets\/scripts-[0-9a-f]{8}\.js$/);
  assert.deepEqual(srcs.slice(1), ['estricto.js', 'c.js', 'c2.js', 'actual.js', 'd.js', 'e.js', 'f.js']);
  const merged = read(dir, `dist/${srcs[0]}`);
  // El separador evita que "var a = 1" se pegue a "(function(){...})()".
  assert.ok(analyzeJs(merged).ok);
  assert.deepEqual([...analyzeJs(merged).top.keys()], ['a']);
  assert.ok(r.coverage.get('a.js')[0].startsWith('unido'));
});

test('si transpilar crearía globales nuevas, se usa una minificación más conservadora', async () => {
  const dir = tempDir();
  writeFiles(dir, {
    'index.html': page('<script src="app.js"></script>'),
    'app.js': 'class Caja { #secreto = 1; leer() { return this.#secreto; } }\nvar caja = new Caja();',
  });
  const r = await buildDir(dir, { js: { target: 'es2018' } });
  const out = read(dir, 'dist/app.js');
  const info = analyzeJs(out);
  assert.deepEqual(Object.fromEntries(info.top), { Caja: 'lex', caja: 'var' });
  assert.ok(r.notes.some((n) => /descartada: aparece una global nueva/.test(n)));
});

test('JSON, BOM y archivos que no son UTF-8 se conservan sin pérdida', async () => {
  const dir = tempDir();
  writeFiles(dir, {
    'index.html': `﻿${page('<p>ñandú</p>')}`,
    'datos.json': '{\n  "n": 12345678901234567890,\n  "d": 2.0\n}\n',
    'roto.json': '{ esto no es json }',
  });
  // HTML en windows-1252 (ñ = 0xF1), sin UTF-8 válido.
  const latin = Buffer.concat([
    Buffer.from('<!doctype html><html><head><meta charset="windows-1252"><title>A'),
    Buffer.from([0xf1]),
    Buffer.from('o</title></head><body>  <img src="x.png">  </body></html>'),
  ]);
  fs.writeFileSync(path.join(dir, 'latin.html'), latin);
  fs.writeFileSync(path.join(dir, 'x.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const r = await buildDir(dir);
  assert.equal(read(dir, 'dist/datos.json'), '{"n":12345678901234567890,"d":2.0}');
  assert.equal(read(dir, 'dist/roto.json'), '{ esto no es json }');
  assert.ok(read(dir, 'dist/index.html').startsWith('﻿'), 'conserva el BOM');
  assert.ok(read(dir, 'dist/index.html').includes('ñandú'));
  assert.ok(fs.readFileSync(path.join(dir, 'dist/latin.html')).includes(Buffer.from([0x41, 0xf1, 0x6f])), 'byte 0xF1 intacto');
  assert.ok(r.warnings.some((w) => w.startsWith('latin.html') && /no es UTF-8/.test(w)));
  assert.deepEqual(fs.readFileSync(path.join(dir, 'dist/x.png')), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
});

test('recalcula integrity (SRI) cuando el contenido cambia', async () => {
  const dir = tempDir();
  const code = 'var mensaje = "hola";   console.log( mensaje );';
  writeFiles(dir, { 'index.html': page(`<script src="app.js" integrity="${sri(code)}" crossorigin="anonymous"></script>`), 'app.js': code });
  await buildDir(dir);
  const html = unquote(read(dir, 'dist/index.html'));
  const out = fs.readFileSync(path.join(dir, 'dist/app.js'));
  assert.ok(html.includes(`integrity=${sri(out)}`), html);
  assert.ok(!html.includes(sri(code)));
});

test('referencias rotas del origen se avisan pero no rompen la compilación', async () => {
  const dir = tempDir();
  writeFiles(dir, { 'index.html': page('<img src="no-existe.png"><a href="falta.pdf">x</a>'), 'borrador/nota.txt': 'x', 'logo.png': 'x' });
  const r = await buildDir(dir, { ignore: ['logo.png'] });
  assert.ok(r.warnings.some((w) => /no-existe\.png" no existe/.test(w)));
  const dir2 = tempDir();
  writeFiles(dir2, { 'index.html': page('<img src="logo.png">'), 'logo.png': 'x' });
  const r2 = await buildDir(dir2, { ignore: ['logo.png'] });
  assert.ok(r2.warnings.some((w) => /logo\.png", pero ese archivo está excluido/.test(w)));
});

test('include fuerza archivos dentro de carpetas excluidas', async () => {
  const dir = tempDir();
  writeFiles(dir, { 'index.html': page('x'), 'privado/secreto.txt': 's', 'privado/publico.txt': 'p' });
  await buildDir(dir, { ignore: ['privado/'], include: ['privado/publico.txt'] });
  assert.ok(exists(dir, 'dist/privado/publico.txt'));
  assert.ok(!exists(dir, 'dist/privado/secreto.txt'));
});

test('archivos no referenciados: process, copy y skip', async () => {
  const files = {
    'index.html': page('<script src="app.js"></script>'),
    'app.js': 'var app = 1;',
    'extra/suelto.js': 'function sueltoMuyLargo(parametro) { return parametro; }',
    'extra/nota.txt': 'n',
  };
  const d1 = tempDir();
  writeFiles(d1, files);
  await buildDir(d1);
  assert.ok(read(d1, 'dist/extra/suelto.js').length < files['extra/suelto.js'].length, 'process: minificado');
  const d2 = tempDir();
  writeFiles(d2, files);
  await buildDir(d2, { unreferenced: 'copy' });
  assert.equal(read(d2, 'dist/extra/suelto.js'), files['extra/suelto.js']);
  const d3 = tempDir();
  writeFiles(d3, files);
  const r3 = await buildDir(d3, { unreferenced: 'skip' });
  assert.ok(!exists(d3, 'dist/extra/suelto.js'));
  assert.ok(!exists(d3, 'dist/extra/nota.txt'));
  assert.ok(r3.coverage.get('extra/suelto.js')[0].includes('omitido'));
});

test('quita modulepreload de módulos que quedaron dentro de un paquete', async () => {
  const dir = tempDir();
  writeFiles(dir, {
    'index.html': page(
      '<script type="module" src="js/main.js"></script>',
      '<link rel="modulepreload" href="js/dep.js"><link rel="modulepreload" href="js/main.js">',
    ),
    'js/main.js': 'import { x } from "./dep.js"; window.r = x;',
    'js/dep.js': 'export const x = 42;',
  });
  const r = await buildDir(dir);
  const html = unquote(read(dir, 'dist/index.html'));
  assert.ok(!html.includes('js/dep.js'));
  assert.ok(html.includes('<link rel=modulepreload href=js/main.js>'));
  assert.ok(!exists(dir, 'dist/js/dep.js'), 'dep.js va dentro de main.js');
  assert.ok(r.coverage.get('js/dep.js')[0].startsWith('empaquetado'));
});

test('import() con ruta variable: los módulos se minifican en su sitio (sin empaquetar)', async () => {
  const dir = tempDir();
  writeFiles(dir, {
    'index.html': page('<script type="module" src="js/router.js"></script>'),
    'js/router.js': 'import { base } from "./base.js"; const pagina = location.hash.slice(1) || "inicio"; import(base + pagina + ".js");',
    'js/base.js': 'export const base = "./paginas/";',
    'js/paginas/inicio.js': 'export const titulo = "Inicio";',
  });
  const r = await buildDir(dir);
  assert.ok(r.notes.some((n) => /módulos sin empaquetar/.test(n)));
  for (const f of ['js/router.js', 'js/base.js', 'js/paginas/inicio.js']) assert.ok(exists(dir, `dist/${f}`), f);
  assert.ok(read(dir, 'dist/js/router.js').includes('"./base.js"'));
});

test('el mismo módulo con import maps distintos no se pisa en silencio', async () => {
  const dir = tempDir();
  const map = (to) => `<script type="importmap">{"imports":{"dep":"./${to}"}}</script>`;
  writeFiles(dir, {
    'a.html': page('<script type="module" src="app.js"></script>', map('uno.js')),
    'b.html': page('<script type="module" src="app.js"></script>', map('dos.js')),
    'app.js': 'import { v } from "dep"; window.v = v;',
    'uno.js': 'export const v = 1;',
    'dos.js': 'export const v = 2;',
  });
  await assert.rejects(buildDir(dir), /Dos resultados distintos quieren escribirse en "app\.js"/);
  // Con hash cada versión tiene su propio nombre.
  await buildDir(dir, { hash: true });
});

test('source maps: archivos .map válidos y enlazados', async () => {
  const dir = copyFixture('modules');
  await buildDir(dir, { sourcemap: true });
  const main = read(dir, 'dist/js/main.js');
  assert.match(main, /\/\/# sourceMappingURL=main\.js\.map\n$/);
  const map = JSON.parse(read(dir, 'dist/js/main.js.map'));
  assert.equal(map.version, 3);
  assert.ok(map.sources.some((s) => s.endsWith('js/main.js')));
  assert.ok(exists(dir, 'dist/css/app.css.map'));
});

test('white-space: pre en el CSS desactiva el colapso de espacios del HTML', async () => {
  const dir = tempDir();
  writeFiles(dir, {
    'index.html': page('<div class="codigo">  a    b  </div>', '<link rel="stylesheet" href="s.css">'),
    's.css': '.codigo { white-space: pre; }',
  });
  const r = await buildDir(dir);
  assert.ok(unquote(read(dir, 'dist/index.html')).includes('<div class=codigo>  a    b  </div>'));
  assert.ok(r.notes.some((n) => /white-space/.test(n)));
});

test('<base href> se respeta al resolver rutas', async () => {
  const dir = tempDir();
  writeFiles(dir, {
    'index.html': page('<img src="logo.png"><script src="app.js"></script>', '<base href="/sub/">'),
    'sub/logo.png': 'x',
    'sub/app.js': 'var app = 1;',
  });
  const r = await buildDir(dir);
  assert.deepEqual(r.broken, []);
  assert.ok(exists(dir, 'dist/sub/logo.png'));
});

test('analyze no escribe nada', async () => {
  const dir = copyFixture('classic');
  const r = await analyze({ dir });
  assert.ok(!exists(dir, 'dist'));
  assert.ok(r.outputs.size > 0);
  assert.equal(r.coverage.size, r.coverage.size);
});

test('la verificación detecta referencias rotas y JS inválido en la salida', async () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'index.html'), page('<script src="falta.js"></script>'));
  fs.writeFileSync(path.join(dir, 'app.js'), 'var = ;');
  const outputs = new Map([
    ['index.html', { data: fs.readFileSync(path.join(dir, 'index.html')), type: 'html' }],
    ['app.js', { data: fs.readFileSync(path.join(dir, 'app.js')), type: 'js' }],
  ]);
  const ctx = { cfg: { base: '/' }, brokenValues: new Set(), files: new Map(), coverage: new Map() };
  const v = await verifyOutput(dir, outputs, ctx);
  assert.ok(v.errors.some((e) => /falta\.js/.test(e)));
  assert.ok(v.errors.some((e) => /app\.js: el JavaScript generado no es válido/.test(e)));
});

test('cobertura: cada archivo del proyecto tiene un destino conocido', async () => {
  for (const name of ['classic', 'modules']) {
    const dir = copyFixture(name);
    const r = await buildDir(dir, { obfuscate: 'low' });
    const files = listFiles(dir).filter((f) => !f.startsWith('dist/'));
    const ignored = new Set(r.ignored.map((i) => i.rel));
    for (const f of files) {
      const rel = f;
      if (!ignored.has(rel)) assert.ok(r.coverage.has(rel), `${name}: ${rel} sin destino`);
    }
    assert.equal(r.verify.errors.length, 0);
  }
});

const isObfuscated = (code) => /_0x[0-9a-f]{4,}/.test(code);

test('dependencias: se detectan y no se ofuscan; se pueden marcar o corregir a mano', async () => {
  const files = {
    'index.html': page(
      '<script src="js/jquery-3.7.1.min.js"></script><script src="vendor/plugin.js"></script><script src="js/app.js"></script><script src="js/propia.js"></script>',
    ),
    'js/jquery-3.7.1.min.js': 'var jQuery = function (selector) { return document.querySelectorAll(selector); };',
    'vendor/plugin.js': 'var Plugin = { iniciar: function () { return "ok"; } };',
    'js/app.js': '/*! Mi app (c) 2026 */\nvar aplicacion = { nombre: "demo", iniciar: function () { return Plugin.iniciar(); } };',
    'js/propia.js': 'var miCodigoPropio = { valor: 42, doble: function () { return this.valor * 2; } };',
  };
  const d1 = tempDir();
  writeFiles(d1, files);
  const r1 = await buildDir(d1, { obfuscate: 'low', js: { mergeClassic: false } });
  assert.ok(!isObfuscated(read(d1, 'dist/js/jquery-3.7.1.min.js')), 'jQuery no se ofusca');
  assert.ok(!isObfuscated(read(d1, 'dist/vendor/plugin.js')), 'vendor/ no se ofusca');
  assert.ok(isObfuscated(read(d1, 'dist/js/app.js')), 'código propio sí');
  assert.ok(read(d1, 'dist/js/app.js').includes('/*! Mi app (c) 2026 */'), 'conserva el aviso de copyright');
  assert.deepEqual(r1.dependencies.map((d) => d.rel).sort(), ['js/jquery-3.7.1.min.js', 'vendor/plugin.js']);
  // A mano: propia.js como dependencia; jquery "no es dependencia" (detección corregida).
  const d2 = tempDir();
  writeFiles(d2, files);
  await buildDir(d2, { obfuscate: 'low', js: { mergeClassic: false }, dependencies: { include: ['js/propia.js'], exclude: ['js/jquery-*.js'] } });
  assert.ok(!isObfuscated(read(d2, 'dist/js/propia.js')));
  assert.ok(isObfuscated(read(d2, 'dist/js/jquery-3.7.1.min.js')));
  // Todo ofuscado si se pide.
  const d3 = tempDir();
  writeFiles(d3, files);
  await buildDir(d3, { obfuscate: 'low', js: { mergeClassic: false }, dependencies: { obfuscate: true } });
  assert.ok(isObfuscated(read(d3, 'dist/vendor/plugin.js')));
});

test('dependencias: UMD, package.json, data-builder en el HTML y @builder-* en el archivo', async () => {
  const dir = tempDir();
  writeFiles(dir, {
    'package.json': JSON.stringify({ name: 'demo', dependencies: { 'chart.js': '^4.4.0' }, devDependencies: { eslint: '9' } }),
    'index.html': page(
      [
        '<script src="js/umdlib.js"></script>',
        '<script src="js/chart.umd.js"></script>',
        '<script src="js/eslint.js"></script>',
        '<script src="js/plugin.js" data-builder="dependency"></script>',
        '<script src="js/marcado.js"></script>',
        '<script src="js/mio.umd.js" data-builder="own"></script>',
        '<script src="js/propio.js"></script>',
      ].join(''),
    ),
    'js/umdlib.js':
      '(function (root, factory) { if (typeof define === "function" && define.amd) define([], factory); else root.Umd = factory(); })(this, function () { return { version: 1 }; });',
    'js/chart.umd.js': 'window.Chart = function Chart() { return 1; };',
    'js/eslint.js': 'var lintConfig = { reglas: ["a", "b"], activar: function () { return this.reglas.length; } };',
    'js/plugin.js': 'var Plugin = { iniciar: function () { return "ok"; } };',
    'js/marcado.js': '/* @builder-dependency */\nvar Marcado = { valor: 1 };',
    'js/mio.umd.js': 'var miUmd = { calcular: function (a, b) { return a * b + 1; } };',
    'js/propio.js': '// @builder-own\n/*! Lib v2.0.0 */\nvar propio = { saludo: function () { return "hola " + Marcado.valor; } };',
  });
  const r = await buildDir(dir, { obfuscate: 'low', js: { mergeClassic: false } });
  const reasons = Object.fromEntries(r.dependencies.map((d) => [d.rel, d.reason]));
  assert.match(reasons['js/umdlib.js'], /UMD/);
  assert.match(reasons['js/plugin.js'], /data-builder/);
  assert.match(reasons['js/marcado.js'], /@builder-dependency/);
  assert.equal(reasons['js/eslint.js'], undefined, 'devDependencies no cuentan');
  assert.equal(reasons['js/mio.umd.js'], undefined, 'data-builder="own" gana a la detección por nombre');
  assert.equal(reasons['js/propio.js'], undefined, '@builder-own gana a la cabecera con versión');
  assert.ok(reasons['js/chart.umd.js'], 'chart.umd.js se detecta (nombre compilado o package.json)');
  for (const rel of ['js/umdlib.js', 'js/plugin.js', 'js/marcado.js']) assert.ok(!isObfuscated(read(dir, `dist/${rel}`)), `${rel} sin ofuscar`);
  for (const rel of ['js/eslint.js', 'js/mio.umd.js', 'js/propio.js']) assert.ok(isObfuscated(read(dir, `dist/${rel}`)), `${rel} ofuscado`);
  // La configuración sigue teniendo la última palabra sobre las marcas.
  const r2 = await buildDir(dir, { obfuscate: 'low', js: { mergeClassic: false }, dependencies: { exclude: ['js/plugin.js'] } });
  assert.ok(!r2.dependencies.some((d) => d.rel === 'js/plugin.js'));
});

test('builder deps: lista y edita builder.config.json sin romper el resto de la configuración', () => {
  const dir = tempDir();
  writeFiles(dir, {
    'index.html': page('<script src="vendor/lib.js"></script><script src="js/app.js"></script>'),
    'vendor/lib.js': 'var Lib = 1;',
    'js/app.js': 'var app = Lib + 1;',
    'builder.config.json': JSON.stringify({ outDir: 'publico', hash: true }),
  });
  const list = cli(dir, 'deps', '--json');
  assert.equal(list.status, 0, list.stderr);
  const parsed = JSON.parse(list.stdout);
  assert.deepEqual(
    parsed.dependencies.map((d) => d.rel),
    ['vendor/lib.js'],
  );
  assert.deepEqual(parsed.own, ['js/app.js']);

  assert.equal(cli(dir, 'deps', 'add', 'js/app.js').status, 0);
  assert.equal(cli(dir, 'deps', 'own', './vendor/lib.js').status, 0);
  let cfg = JSON.parse(read(dir, 'builder.config.json'));
  assert.deepEqual(cfg.dependencies, { include: ['js/app.js'], exclude: ['vendor/lib.js'] });
  assert.equal(cfg.outDir, 'publico', 'conserva las demás opciones');
  const after = JSON.parse(cli(dir, 'deps', '--json').stdout);
  assert.deepEqual(
    after.dependencies.map((d) => d.rel),
    ['js/app.js'],
  );

  assert.equal(cli(dir, 'deps', 'reset', 'js/app.js', 'vendor/lib.js').status, 0);
  cfg = JSON.parse(read(dir, 'builder.config.json'));
  assert.deepEqual(cfg.dependencies, { include: [], exclude: [] });
  // Desde otra carpeta con --dir, y sin patrones da un error claro.
  assert.equal(cli(path.dirname(dir), 'deps', 'add', 'js/app.js', '--dir', path.basename(dir)).status, 0);
  const bad = cli(dir, 'deps', 'add');
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr + bad.stdout, /Indica uno o más archivos/);
});

test('TypeScript: se transpila, sale como .js, el HTML apunta a la salida y el código funciona', async () => {
  const vm = await import('node:vm');
  const { pathToFileURL } = await import('node:url');
  const files = {
    // spawn.js no existe: es spawn.ts (convención de TypeScript); su salida será justo js/spawn.js.
    'index.html': page(
      '<script src="js/legacy.ts"></script><script type="module" src="js/main.ts"></script><script type="module" src="js/spawn.js"></script>',
    ),
    'tsconfig.json': '{\n  // comentarios permitidos (JSONC)\n  "compilerOptions": { "target": "ES2022", "strict": true }\n}\n',
    'js/legacy.ts':
      'interface Cfg { n: number }\nvar legacyCfg: Cfg = { n: 2 };\nfunction doble(x: number): number { return x * legacyCfg.n; }\nvar legacyResult: number = doble(21);\n',
    'js/main.ts': [
      "import { suma } from './math.ts';",
      "import type { Punto } from './tipos';",
      "import { Color } from './color.js';",
      "import { doblar } from './lib';",
      'const p: Punto = { x: 1, y: 2 };',
      'export const resultado: number = suma(p.x, p.y) + Color.Verde + doblar(1);',
      '(globalThis as any).tsResult = resultado;',
    ].join('\n'),
    'js/math.ts': 'export function suma(a: number, b: number): number { return a + b; }\n',
    'js/lib/index.ts': 'export const doblar = (n: number): number => n * 2;\n',
    'js/tipos.ts': 'export interface Punto { x: number; y: number }\n',
    'js/color.ts': 'export enum Color { Rojo = 1, Verde = 2 }\n',
    'js/spawn.ts': "const w: Worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });\nexport { w };\n",
    'js/worker.ts': 'const n: number = 5;\nself.postMessage(n);\n',
    'js/types.d.ts': 'declare const algo: number;\n',
    'js/extra.ts': "export const e: string = 'suelto';\n",
  };
  // Por defecto, ofuscado y sin empaquetar (cada módulo en su sitio: los imports deben quedar resolubles).
  for (const overrides of [{}, { obfuscate: 'low' }, { js: { bundle: false } }]) {
    const dir = tempDir();
    writeFiles(dir, files);
    const r = await buildDir(dir, overrides);
    assert.deepEqual(r.warnings, [], JSON.stringify(overrides));
    const out = [...r.outputs.keys()];
    assert.deepEqual(
      out.filter((k) => /\.(m|c)?ts$/.test(k)),
      [],
      'ningún .ts en la salida',
    );
    for (const k of ['js/legacy.js', 'js/main.js', 'js/spawn.js', 'js/worker.js', 'js/extra.js']) assert.ok(r.outputs.has(k), `existe ${k}`);
    fs.writeFileSync(path.join(dir, 'dist/package.json'), '{"type":"module"}');
    assert.ok(
      r.ignored.some((i) => i.rel === 'js/types.d.ts'),
      '.d.ts excluido',
    );
    const html = unquote(read(dir, 'dist/index.html'));
    assert.ok(!/\.ts["> ]/.test(html), 'el HTML ya no apunta a .ts');
    assert.match(html, /js\/legacy\.js/);
    assert.match(read(dir, 'dist/js/spawn.js'), /worker\.js/);
    assert.doesNotMatch(read(dir, 'dist/js/spawn.js'), /worker\.ts/);
    // El script clásico mantiene sus globales y calcula lo mismo.
    const sandbox = {};
    vm.runInNewContext(read(dir, 'dist/js/legacy.js'), sandbox);
    assert.equal(sandbox.legacyResult, 42);
    assert.equal(typeof sandbox.doble, 'function');
    // El módulo (con imports sin extensión, import type y enum) se ejecuta de verdad.
    delete globalThis.tsResult;
    await import(`${pathToFileURL(path.join(dir, 'dist/js/main.js')).href}?v=${Math.random()}`);
    assert.equal(globalThis.tsResult, 7);
  }
});

test('TypeScript inválido: se avisa y no se pierde el archivo', async () => {
  const dir = tempDir();
  writeFiles(dir, { 'index.html': page('<script src="js/roto.ts"></script>'), 'js/roto.ts': 'const x: = 1;\n' });
  const r = await buildDir(dir);
  assert.ok(r.warnings.some((w) => /TypeScript no válido/.test(w)));
  assert.ok(exists(dir, 'dist/js/roto.ts'), 'se copia tal cual');
});

test('idioma: inglés por defecto fuera de un sistema en español, --lang y BUILDER_LANG', () => {
  const dir = copyFixture('classic');
  const run = (env, ...args) =>
    spawnSync(process.execPath, [CLI, ...args], {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, NO_COLOR: '1', BUILDER_LANG: '', LC_ALL: '', LC_MESSAGES: '', ...env },
    });
  const en = run({ LANG: 'en_US.UTF-8' }, 'build', '--obfuscate', 'low');
  assert.equal(en.status, 0, en.stderr);
  assert.match(en.stdout, /Verification: \d+ files written/);
  assert.match(en.stdout, /Detected dependencies \(not obfuscated\)/);
  assert.doesNotMatch(en.stdout, /Verificación|archivos/);
  const es = run({ LANG: 'en_US.UTF-8', BUILDER_LANG: 'es' }, 'build');
  assert.match(es.stdout, /Verificación: \d+ archivos escritos/);
  const flag = run({ LANG: 'es_MX.UTF-8' }, 'analyze', '--lang', 'en');
  assert.match(flag.stdout, /What will happen to each project file/);
  // Los estados de cobertura se traducen junto con las comparaciones que los usan.
  assert.match(flag.stdout, /bundled|processed|merged/);
  assert.doesNotMatch(flag.stdout, /empaquetado|procesado|unido/);
  // Errores en inglés y --json con los mismos campos en cualquier idioma.
  const bad = run({ LANG: 'en_US.UTF-8' }, 'build', '--out', '.', '--json');
  assert.notEqual(bad.status, 0);
  assert.match(JSON.parse(bad.stdout).error, /cannot be the project folder/);
  const help = run({ LANG: 'en_US.UTF-8' }, 'help');
  assert.match(help.stdout, /Usage:/);
  assert.match(run({}, 'help', '--lang=es').stdout, /Uso:/);
});

test('idioma: en inglés, las comparaciones de estados internos siguen funcionando', async () => {
  const { setLang } = await import('../src/i18n.js');
  setLang('en');
  try {
    const dir = tempDir();
    writeFiles(dir, {
      'index.html': page('<script type="module" src="js/main.js"></script>'),
      'js/main.js': "import { N } from './const.js';\nconsole.log(N);\nfetch('extra/datos.json');\n",
      'js/const.js': 'export const N = 1;\n',
      'extra/suelto.js': 'var suelto = 1;\n',
      'extra/datos.json': '{ "a": 1 }',
    });
    const r = await buildDir(dir, { unreferenced: 'copy' });
    const cov = Object.fromEntries(r.coverage);
    assert.ok(
      cov['js/const.js'].some((s) => s.startsWith('bundled')),
      JSON.stringify(cov['js/const.js']),
    );
    assert.deepEqual(cov['extra/suelto.js'], ['unreferenced: copied → extra/suelto.js']);
    assert.ok(exists(dir, 'dist/extra/suelto.js'));
    assert.ok(exists(dir, 'dist/extra/datos.json'));
    assert.ok(
      r.perf.phases.some(([name]) => name === 'modules'),
      'las fases van siempre en inglés',
    );
  } finally {
    setLang('es');
  }
});

test('navegadores: browserslist del proyecto añade prefijos y adapta CSS y JS; browsers: false lo desactiva', async () => {
  const files = {
    'package.json': JSON.stringify({ name: 'demo', browserslist: ['safari 13'] }),
    'index.html': '<!doctype html><html><head><link rel="stylesheet" href="app.css"></head><body><script src="app.js"></script></body></html>',
    'app.css': '.card { backdrop-filter: blur(4px); & .title { color: red; } }\n',
    'app.js': 'var opciones = window.config ?? { modo: "claro" };\n',
  };
  const dir = tempDir();
  writeFiles(dir, files);
  const r = await buildDir(dir);
  const css = read(dir, 'dist/app.css');
  assert.match(css, /-webkit-backdrop-filter/, 'prefijo para Safari 13');
  assert.match(css, /\.card \.title/, 'CSS anidado aplanado');
  assert.doesNotMatch(read(dir, 'dist/app.js'), /\?\?/, '?? adaptado para Safari 13');
  assert.equal(r.warnings.length, 0, r.warnings.join('\n'));

  const off = tempDir();
  writeFiles(off, files);
  await buildDir(off, { browsers: false });
  assert.doesNotMatch(read(off, 'dist/app.css'), /-webkit-backdrop-filter/);
  assert.match(read(off, 'dist/app.js'), /\?\?/);
});

test('navegadores: .browserslistrc con secciones y consulta explícita en la configuración', async () => {
  const { findBrowsersQuery, toEsbuildTargets } = await import('../src/browsers.js');
  const dir = tempDir();
  writeFiles(dir, { '.browserslistrc': '# comentario\nchrome 100\n\n[production]\nfirefox 115\n[development]\nlast 1 chrome version\n' });
  assert.deepEqual(findBrowsersQuery(dir, 'auto'), { query: 'firefox 115', from: '.browserslistrc' });
  assert.equal(findBrowsersQuery(dir, false), null);
  assert.deepEqual(findBrowsersQuery(dir, 'safari 15'), { query: 'safari 15', from: 'browsers' });
  assert.deepEqual(toEsbuildTargets(['chrome 120', 'chrome 109', 'ios_saf 18.5-18.7', 'and_chr 130', 'samsung 30', 'ie 11', 'safari TP']), {
    targets: ['chrome109', 'ios18.5'],
    ignored: ['ie', 'safari', 'samsung'],
  });
  writeFiles(dir, { 'index.html': page('<p>x</p>'), 'a.css': 'a { user-select: none; }' });
  await buildDir(dir, { browsers: 'safari 13', include: ['a.css'] });
  assert.match(read(dir, 'dist/a.css'), /-webkit-user-select/);
});

let sharpLib = null;
try {
  sharpLib = (await import('sharp')).default;
} catch {
  // sharp necesita Node 20+: en Node 16/18 estas pruebas se saltan.
}

test(
  'imágenes: PNG sin pérdida (mismos píxeles), JPEG más pequeño con metadatos; lo ya optimizado se copia',
  { skip: !sharpLib && 'sharp no disponible' },
  async () => {
    const sharp = sharpLib;
    const width = 64;
    const height = 48;
    const raw = Buffer.alloc(width * height * 3);
    for (let i = 0; i < raw.length; i += 3) {
      raw[i] = ((i / 3) % width) * 4;
      raw[i + 1] = Math.floor(i / 3 / width) * 5;
      raw[i + 2] = 128;
    }
    const img = () => sharp(raw, { raw: { width, height, channels: 3 } });
    const png = await img().png({ compressionLevel: 0 }).toBuffer();
    const jpg = await img().jpeg({ quality: 100 }).withMetadata({ orientation: 6 }).toBuffer();
    const tiny = await img().png({ compressionLevel: 9, palette: true, colours: 2 }).toBuffer();
    const dir = tempDir();
    writeFiles(dir, { 'index.html': page('<img src="a.png"><img src="b.jpg"><img src="c.png"><img src="d.gif">') });
    fs.writeFileSync(path.join(dir, 'a.png'), png);
    fs.writeFileSync(path.join(dir, 'b.jpg'), jpg);
    fs.writeFileSync(path.join(dir, 'c.png'), tiny);
    fs.writeFileSync(path.join(dir, 'd.gif'), Buffer.from('R0lGODlhAQABAAAAACw=', 'base64'));
    const r = await buildDir(dir, { images: true });
    const outPng = fs.readFileSync(path.join(dir, 'dist/a.png'));
    const outJpg = fs.readFileSync(path.join(dir, 'dist/b.jpg'));
    assert.ok(outPng.length < png.length, 'PNG más pequeño');
    const [p1, p2] = await Promise.all([sharp(png).raw().toBuffer(), sharp(outPng).raw().toBuffer()]);
    assert.ok(p1.equals(p2), 'PNG con exactamente los mismos píxeles');
    assert.ok(outJpg.length < jpg.length, 'JPEG más pequeño');
    const mj = await sharp(outJpg).metadata();
    assert.equal(mj.width, width);
    assert.equal(mj.orientation, 6, 'conserva la orientación EXIF');
    assert.ok(fs.readFileSync(path.join(dir, 'dist/d.gif')).equals(fs.readFileSync(path.join(dir, 'd.gif'))), 'GIF intacto');
    const cov = Object.fromEntries(r.coverage);
    assert.match(cov['a.png'][0], /imagen optimizada/);
    assert.match(cov['c.png'][0], /copiado \(ya estaba optimizada\)/);
    assert.equal(r.report.rows.find((x) => x.file === 'a.png').action, 'image');
    // Sin --images no se toca ninguna imagen.
    const off = tempDir();
    writeFiles(off, { 'index.html': page('<img src="a.png">') });
    fs.writeFileSync(path.join(off, 'a.png'), png);
    await buildDir(off);
    assert.ok(fs.readFileSync(path.join(off, 'dist/a.png')).equals(png));
  },
);

test('dependencias: un archivo con el nombre de un paquete de package.json', async () => {
  const dir = tempDir();
  writeFiles(dir, {
    'package.json': JSON.stringify({ dependencies: { 'chart.js': '4', '@popperjs/core': '2' } }),
    'index.html': page('<script src="js/chart.js"></script><script src="js/popperjs-2.11.8.js"></script><script src="js/core.js"></script>'),
    'js/chart.js': 'window.Chart = 1;',
    'js/popperjs-2.11.8.js': 'window.Popper = 1;',
    'js/core.js': 'window.core = 1;',
  });
  const r = await buildDir(dir, { obfuscate: 'low', js: { mergeClassic: false } });
  const reasons = Object.fromEntries(r.dependencies.map((d) => [d.rel, d.reason]));
  assert.match(reasons['js/chart.js'], /"chart\.js" de tu package\.json/);
  assert.match(reasons['js/popperjs-2.11.8.js'], /"@popperjs\/core"/);
  assert.equal(reasons['js/core.js'], undefined, 'nombres genéricos no bastan');
});

test('paquetes de npm: van a un archivo vendor sin ofuscar y comparten estado', async () => {
  const dir = copyFixture('npm');
  const r = await buildDir(dir, { obfuscate: 'medium' });
  const vendor = read(dir, 'dist/assets/vendor/fake-lib.js');
  assert.ok(!isObfuscated(vendor));
  assert.ok(isObfuscated(read(dir, 'dist/js/main.js')));
  assert.match(read(dir, 'dist/js/main.js'), /\.\.\/assets\/vendor\/fake-lib\.js/);
  assert.deepEqual(r.vendor.sort(), ['fake-lib', 'fake-lib/extra.js']);
  assert.ok(!exists(dir, 'dist/node_modules'), 'node_modules no se publica');
});

test('precompresión: .gz y .br idénticos al descomprimir', async () => {
  const zlib = await import('node:zlib');
  const dir = copyFixture('classic');
  await buildDir(dir, { compress: true });
  for (const f of ['index.html', 'js/app2.js'].filter((x) => exists(dir, `dist/${x}`))) {
    const orig = fs.readFileSync(path.join(dir, 'dist', f));
    if (orig.length < 1024) continue;
    assert.deepEqual(zlib.gunzipSync(fs.readFileSync(path.join(dir, 'dist', `${f}.gz`))), orig);
    assert.deepEqual(zlib.brotliDecompressSync(fs.readFileSync(path.join(dir, 'dist', `${f}.br`))), orig);
  }
  const merged = listFiles(path.join(dir, 'dist')).find(
    (f) => /^assets\/scripts-.*\.js$/.test(f) && fs.statSync(path.join(dir, 'dist', f)).size >= 1024,
  );
  assert.ok(merged && exists(dir, `dist/${merged}.br`));
});

test('terser: la compresión máxima nunca agranda el JS', async () => {
  const sizes = {};
  for (const minifier of ['esbuild', 'terser']) {
    const dir = copyFixture('modules');
    const r = await buildDir(dir, { js: { minifier } });
    sizes[minifier] = r.report.rows.filter((x) => x.type === 'js').reduce((a, x) => a + x.size, 0);
  }
  assert.ok(sizes.terser <= sizes.esbuild, JSON.stringify(sizes));
});
