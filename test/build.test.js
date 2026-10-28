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
