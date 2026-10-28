// Pruebas de las piezas internas (sin compilar proyectos completos).
import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeJs, compareGlobals, moduleShape } from '../src/jsinfo.js';
import { imageSetStringsToUrl } from '../src/css.js';
import { parseSrcset, classifyUrl, resolveRef } from '../src/urls.js';
import { minifyHtml, htmlSignature, applyEdits, escapeInlineScript, detectPreWhitespace } from '../src/html.js';
import { minifyJsonText } from '../src/util.js';
import { replaceWithMap } from '../src/sourcemap.js';
import { rebaseImports } from '../src/js.js';
import { normalizeConfig } from '../src/config.js';
import { obfuscateSafe, resolveObfuscatorOptions, ensureObfuscator } from '../src/obfuscate.js';
import { cssRefs } from '../src/verify.js';

test('analyzeJs: detecta el nivel ES mínimo del código', () => {
  assert.equal(analyzeJs('var a = 1;').level, 5);
  assert.equal(analyzeJs('let a = () => 1;').level, 2015);
  assert.equal(analyzeJs('const b = a?.c ?? 1;').level, 2020);
  assert.equal(analyzeJs('class A { #x = 1 }').level, 2022);
  assert.equal(analyzeJs('export const x = 1; await 0;', { module: true }).level, 2022);
});

test('analyzeJs: globales de un script clásico (var/function elevadas, let/const/class léxicas)', () => {
  const info = analyzeJs('var a; let b; const {c, d: [e]} = o; function f(){ var interna; } class G {} if (x) { var h = 1; } for (var i of []) {}');
  assert.deepEqual(Object.fromEntries(info.top), { b: 'lex', c: 'lex', e: 'lex', G: 'lex', a: 'var', f: 'var', h: 'var', i: 'var' });
  assert.equal(info.strict, false);
  assert.equal(analyzeJs('"use strict"; var a;').strict, true);
});

test('analyzeJs: workers, service workers, importScripts, new URL y textos que parecen rutas', () => {
  const info = analyzeJs(
    `new Worker('w.js'); new SharedWorker(new URL('./s.js', import.meta.url), { type: 'module' });
     navigator.serviceWorker.register('/sw.js'); importScripts('a.js', 'b.js');
     const precache = ['img/logo.png', 'css/app.css']; import('./lazy.js');`,
    { module: true },
  );
  assert.deepEqual(
    info.workers.map((w) => [w.kind, w.spec, w.module, w.viaUrl]),
    [
      ['worker', 'w.js', false, false],
      ['sharedworker', './s.js', true, true],
      ['serviceworker', '/sw.js', false, false],
      ['importScripts', 'a.js', false, false],
      ['importScripts', 'b.js', false, false],
    ],
  );
  assert.deepEqual(
    info.urls.map((u) => u.spec),
    ['./s.js'],
  );
  assert.deepEqual([...info.strings].sort(), ['css/app.css', 'img/logo.png']);
});

test('analyzeJs: document.currentScript y window.__currentScript no se confunden', () => {
  assert.equal(analyzeJs('document.currentScript.dataset.x').usesCurrentScript, true);
  assert.equal(analyzeJs('window.__currentScript = 1').usesCurrentScript, false);
});

test('compareGlobals: detecta globales nuevas, perdidas o que cambian de tipo', () => {
  const before = analyzeJs('var a = 1; let b = 2; function c(){}').top;
  assert.equal(compareGlobals(before, 'var a=1;let b=2;function c(){}').ok, true);
  assert.match(compareGlobals(before, 'var a=1,e=3;let b=2;function c(){}').reason, /global nueva "e"/);
  assert.match(compareGlobals(before, 'var a=1;function c(){}').reason, /desaparece la global "b"/);
  assert.match(compareGlobals(before, 'var a=1;var b=2;function c(){}').reason, /cambia de tipo/);
  assert.equal(compareGlobals(before, 'var a=1,_x1=3;let b=2;function c(){}', '_x').ok, true);
});

test('moduleShape: incluye los atributos de import', () => {
  const a = moduleShape(`import s from './a.css' with { type: 'css' }; export const x = 1;`);
  const b = moduleShape(`import s from './a.css'; export const x = 1;`);
  assert.notEqual(a.imports, b.imports);
  assert.equal(a.exports, 'x');
});

test('ofuscación de script clásico: conserva las globales y prefija las suyas', async () => {
  await ensureObfuscator();
  const code = 'var contador = 0; function sumar(a, b) { return a + b + contador; } let estado = { ok: true };';
  const info = analyzeJs(code);
  const r = obfuscateSafe(code, { isModule: false, options: resolveObfuscatorOptions('high'), id: 'x.js', globals: info.top });
  assert.ok(r.code, r.reason);
  assert.notEqual(r.code, code);
  const after = analyzeJs(r.code);
  for (const name of ['contador', 'sumar', 'estado']) assert.ok(after.top.has(name), `falta ${name}`);
  // Determinista: misma entrada, misma salida.
  assert.equal(obfuscateSafe(code, { isModule: false, options: resolveObfuscatorOptions('high'), id: 'x.js', globals: info.top }).code, r.code);
});

test('image-set con textos se convierte a url() (y no toca type())', () => {
  assert.equal(
    imageSetStringsToUrl('a{b:image-set("x.png" 1x, url(y.png) 2x, "z.avif" type("image/avif"))}'),
    'a{b:image-set(url("x.png") 1x, url(y.png) 2x, url("z.avif") type("image/avif"))}',
  );
  assert.equal(imageSetStringsToUrl("a{b:-webkit-image-set('x.png' 1x)}"), "a{b:-webkit-image-set(url('x.png') 1x)}");
  assert.equal(imageSetStringsToUrl('a{content:"image-set"}'), 'a{content:"image-set"}');
});

test('srcset: candidatos con descriptores y data: URLs con comas', () => {
  assert.deepEqual(
    parseSrcset('a.png 1x, b.png 2x').map((c) => c.url),
    ['a.png', 'b.png'],
  );
  assert.deepEqual(
    parseSrcset('data:image/png;base64,AAA= 1x, c.png 300w').map((c) => c.url),
    ['data:image/png;base64,AAA=', 'c.png'],
  );
  assert.deepEqual(
    parseSrcset('  x.png  ').map((c) => c.url),
    ['x.png'],
  );
});

test('URLs: clasificación y resolución', () => {
  assert.equal(classifyUrl('https://x.com/a.js').type, 'external');
  assert.equal(classifyUrl('//cdn/a.js').type, 'external');
  assert.equal(classifyUrl('#top').type, 'fragment');
  assert.equal(classifyUrl('{{ url }}').type, 'dynamic');
  assert.deepEqual(classifyUrl('img/a%20b.png?v=1#x'), {
    type: 'relative',
    value: 'img/a%20b.png?v=1#x',
    path: 'img/a b.png',
    rawPath: 'img/a%20b.png',
    suffix: '?v=1#x',
  });
  const files = new Map([
    ['img/a b.png', {}],
    ['sub/index.html', {}],
    ['Foto.PNG', {}],
  ]);
  const ctx = { files, base: '/', lowerMap: new Map([...files.keys()].map((k) => [k.toLowerCase(), k])) };
  assert.equal(resolveRef('../img/a%20b.png', 'css', ctx).rel, 'img/a b.png');
  assert.equal(resolveRef('/img/a%20b.png', 'x/y', ctx).rel, 'img/a b.png');
  assert.equal(resolveRef('sub/', '', ctx).rel, 'sub/index.html');
  assert.equal(resolveRef('../../fuera.png', 'a', ctx).status, 'outside');
  assert.equal(resolveRef('foto.png', '', ctx).status, 'case');
});

test('JSON: minificación sin pérdida (números grandes, decimales y cadenas intactos)', () => {
  const src = '{\n  "n": 12345678901234567890,\n  "d": 2.0,\n  "s": "a  b \\" c",\n  "e": 1e400\n}';
  const out = minifyJsonText(src);
  assert.equal(out, '{"n":12345678901234567890,"d":2.0,"s":"a  b \\" c","e":1e400}');
  assert.equal(minifyJsonText('{malo'), null);
});

test('source map: al reemplazar texto se desplazan las columnas', () => {
  // "AAAA" = columna 0; "UAAU" = +10 columnas generadas, +10 columnas originales
  const map = JSON.stringify({ version: 3, sources: ['a.js'], names: [], mappings: 'AAAA,UAAU' });
  const r = replaceWithMap('x="__M__/a";y=1', map, '__M__/', './');
  assert.equal(r.code, 'x="./a";y=1');
  const seg = JSON.parse(r.map).mappings.split(',');
  assert.equal(seg[0], 'AAAA');
  assert.equal(seg[1], 'MAAU'); // 10 - 4 = 6 → "M"
});

test('rebaseImports: recalcula rutas relativas al mover un módulo', () => {
  const code = 'import{a}from"./chunk.js";export*from"../x.js";import("./lazy.js");import"https://cdn/x.js";';
  assert.equal(
    rebaseImports(code, 'assets/inline.js', 'index.html'),
    'import{a}from"./assets/chunk.js";export*from"./x.js";import("./assets/lazy.js");import"https://cdn/x.js";',
  );
});

test('HTML: ediciones puntuales y escape de </script>', () => {
  assert.equal(
    applyEdits('0123456789', [
      { start: 2, end: 4, text: 'ab' },
      { start: 6, end: 6, text: 'X' },
    ]),
    '01ab45X6789',
  );
  assert.throws(() =>
    applyEdits('0123', [
      { start: 0, end: 3, text: '' },
      { start: 2, end: 4, text: '' },
    ]),
  );
  assert.equal(escapeInlineScript('a="</script><!--"'), 'a="<\\/script><\\!--"');
});

test('HTML: minificación conservadora que no cambia estructura, <pre>, ni plantillas', async () => {
  const html = `<!doctype html>\n<html>\n<head>\n  <title>t</title>\n  <!-- quitar -->\n  <!--#include virtual="ssi" -->\n</head>\n<body>\n  <p class="  a   b ">Hola    <b>mundo</b> y&nbsp;más</p>\n  <pre>  a\n    b</pre>\n  <script type="text/template">  <i>  x  </i>  </script>\n  <input disabled="disabled" value="  dos  espacios ">\n</body>\n</html>`;
  const r = await minifyHtml(html, { removeComments: true, collapseWhitespace: true });
  assert.equal(r.note, undefined);
  assert.ok(r.code.length < html.length);
  assert.ok(!r.code.includes('quitar'));
  assert.ok(r.code.includes('<!--#include virtual="ssi" -->'), 'conserva comentarios SSI');
  assert.ok(r.code.includes('<pre>  a\n    b</pre>'));
  assert.ok(r.code.includes('<script type=text/template>  <i>  x  </i>  </script>'), 'plantilla intacta');
  assert.ok(r.code.includes('<input disabled value='), 'booleano simplificado');
  assert.ok(r.code.startsWith('<!doctype html><html><head><title>t</title>'));
  assert.ok(r.code.includes('value="  dos  espacios "'));
  assert.equal(htmlSignature(r.code), htmlSignature(html));
});

test('HTML: detecta white-space: pre en CSS', () => {
  assert.equal(detectPreWhitespace('.a{white-space: pre-wrap}'), true);
  assert.equal(detectPreWhitespace('.a{white-space:nowrap}'), false);
});

test('CSS: extracción de url() e @import para verificar', () => {
  assert.deepEqual(cssRefs('@import"a.css";b{c:url(x\\ y.png)}d{e:url( "z.svg#i" )}/* url(no.png) */'), ['a.css', 'x y.png', 'z.svg#i']);
});

test('configuración: avisa de opciones mal escritas con sugerencia', () => {
  const errors = [];
  normalizeConfig({ obfuscte: true, js: { minfy: false }, unreferenced: 'nada' }, errors);
  assert.ok(errors.some((e) => e.includes('"obfuscte"') && e.includes('obfuscate')));
  assert.ok(errors.some((e) => e.includes('"js.minfy"') && e.includes('minify')));
  assert.ok(errors.some((e) => e.includes('"unreferenced"')));
  const ok = [];
  const cfg = normalizeConfig({ obfuscate: true, base: '/sitio' }, ok);
  assert.deepEqual(ok, []);
  assert.equal(cfg.obfuscate, 'medium');
  assert.equal(cfg.base, '/sitio/');
});
