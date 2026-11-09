// Genera un sitio vanilla sintético y grande para medir el rendimiento del builder.
// Uso: node bench/generate.mjs <carpeta> [escala]   (escala 1 ≈ 40 páginas, 240 módulos, 120 scripts clásicos)
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const [dir = 'bench/.site', scaleArg = '1'] = process.argv.slice(2);
const scale = Math.max(1, Number(scaleArg) || 1);
const PAGES = 40 * scale;
const MODULES = 240 * scale;
const CLASSIC = 120 * scale;
const CSS = 30 * scale;
const IMAGES = 200 * scale;

fs.rmSync(dir, { recursive: true, force: true });
const write = (rel, text) => {
  const abs = path.join(dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, text);
};

// Código "realista": clases, closures, cadenas y bucles, para que minificar y ofuscar cuesten de verdad.
const body = (name, i) => `
export class ${name} {
  constructor(options = {}) {
    this.options = { size: ${i % 17}, label: '${name} número ${i}', ...options };
    this.items = [];
    this.listeners = new Map();
  }
  add(value) {
    const item = { id: this.items.length + 1, value, createdAt: Date.now() };
    this.items.push(item);
    this.emit('add', item);
    return item;
  }
  on(event, fn) {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event).add(fn);
    return () => this.listeners.get(event).delete(fn);
  }
  emit(event, payload) {
    for (const fn of this.listeners.get(event) ?? []) fn(payload, this);
  }
  summary() {
    let total = 0;
    for (const { value } of this.items) total += typeof value === 'number' ? value : String(value).length;
    return \`\${this.options.label}: \${this.items.length} elementos, total \${total}\`;
  }
}
`;

for (let i = 0; i < MODULES; i++) {
  const deps = [1, 2, 3].map((d) => (i + d * 7) % MODULES).filter((d) => d > i);
  const imports = deps.map((d) => `import { M${d} } from './m${d}.js';`).join('\n');
  const uses = deps.map((d) => `  new M${d}().add(${i});`).join('\n');
  write(`js/mods/m${i}.js`, `${imports}\n${body(`M${i}`, i)}\nexport function run${i}() {\n${uses}\n  return new M${i}().summary();\n}\n`);
}
for (let p = 0; p < PAGES; p++) {
  const entry = (p * 6) % MODULES;
  write(`js/pages/page${p}.js`, `import { run${entry} } from '../mods/m${entry}.js';\ndocument.querySelector('#out').textContent = run${entry}();\n`);
}
for (let i = 0; i < CLASSIC; i++) {
  write(
    `js/classic/c${i}.js`,
    `(function () {\n  var registry = window.registry || (window.registry = {});\n  function helper${i}(list) {\n    return list.map(function (x, k) { return { k: k, v: x * ${i + 1}, text: 'elemento ' + k }; });\n  }\n  registry.c${i} = helper${i}([1, 2, 3, 4, 5, 6, 7, 8]);\n})();\n`,
  );
}
for (let i = 0; i < CSS; i++) {
  const rules = Array.from(
    { length: 60 },
    (_, r) =>
      `.c${i}-r${r} { display: flex; margin: ${r}px ${r % 5}px; color: #${(i * 99 + r * 7).toString(16).padStart(3, '0').slice(0, 3)}; transition: opacity .2s ease-in-out; }`,
  );
  write(`css/c${i}.css`, `@import './base.css';\n${rules.join('\n')}\n.bg${i} { background: url('../img/i${i % IMAGES}.svg'); }\n`);
}
write('css/base.css', 'html { box-sizing: border-box; } *, *::before, *::after { box-sizing: inherit; }\n');
for (let i = 0; i < IMAGES; i++)
  write(
    `img/i${i}.svg`,
    `<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="${(i % 8) + 1}" height="8" fill="#${(i * 37).toString(16).padStart(3, '0').slice(0, 3)}"/></svg>\n`,
  );

// Librerías de terceros reales copiadas a mano en vendor/ (deben detectarse y no ofuscarse).
const libs = [
  ['acorn/dist/acorn.js', 'js/vendor/acorn.js'],
  ['picomatch/lib/picomatch.js', 'js/vendor/picomatch.js'],
];
for (const [from, to] of libs) {
  try {
    write(to, fs.readFileSync(require.resolve(from), 'utf8'));
  } catch {
    write(to, '/*! fake-lib v1.0.0 */\nwindow.fakeLib = {};\n');
  }
}

for (let p = 0; p < PAGES; p++) {
  const classic = [0, 1, 2].map((k) => `<script src="js/classic/c${(p * 3 + k) % CLASSIC}.js"></script>`).join('\n    ');
  const css = [0, 1].map((k) => `<link rel="stylesheet" href="css/c${(p * 2 + k) % CSS}.css">`).join('\n    ');
  write(
    `${p === 0 ? 'index' : `page${p}`}.html`,
    `<!doctype html>
<html lang="es">
  <head>
    <meta charset="utf-8">
    <title>Página ${p}</title>
    ${css}
  </head>
  <body>
    <!-- comentario que se quita -->
    <h1 class="c${p % CSS}-r1">Página ${p}</h1>
    <p id="out"></p>
    <img src="img/i${p % IMAGES}.svg" alt="">
    <a href="${p + 1 < PAGES ? `page${p + 1}.html` : 'index.html'}">siguiente</a>
    <script src="js/vendor/acorn.js"></script>
    ${classic}
    <script type="module" src="js/pages/page${p}.js"></script>
  </body>
</html>
`,
  );
}
console.log(`Sitio generado en ${dir}: ${PAGES} páginas, ${MODULES} módulos, ${CLASSIC} scripts clásicos, ${CSS} CSS, ${IMAGES} imágenes`);
