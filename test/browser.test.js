// Prueba definitiva de "sin pérdida": el sitio compilado debe comportarse exactamente igual
// que el original en un navegador real (mismos resultados, sin errores ni 404).
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { copyFixture, buildDir, runInBrowser, findBrowser } from './helpers.js';

const skip = findBrowser() ? false : 'no hay Chromium disponible (define BUILDER_CHROMIUM)';

const SCENARIOS = [
  { fixture: 'classic', pages: ['index.html', 'about.html'] },
  { fixture: 'modules', pages: ['index.html', 'admin/index.html'] },
];
const VARIANTS = [
  { name: 'por defecto', overrides: {} },
  { name: 'ofuscación alta + hash', overrides: { obfuscate: 'high', hash: true } },
  { name: 'sin minificar', overrides: { js: { minify: false }, css: { minify: false }, html: { minify: false } } },
];

for (const { fixture, pages } of SCENARIOS) {
  for (const v of VARIANTS) {
    test(`${fixture} (${v.name}): se comporta igual que el original`, { skip, timeout: 180000 }, async () => {
      const dir = copyFixture(fixture);
      const src = await runInBrowser(dir, pages);
      await buildDir(dir, v.overrides);
      const dist = await runInBrowser(path.join(dir, 'dist'), pages);
      for (const p of pages) {
        assert.deepEqual(src[p].errors, [], `el original de ${p} ya tiene errores`);
        assert.ok(src[p].results, `el original de ${p} no produjo resultados`);
        assert.deepEqual(dist[p].failed, [], `${p}: peticiones fallidas en la salida`);
        assert.deepEqual(dist[p].errors, [], `${p}: errores en la salida`);
        assert.deepEqual(dist[p].results, src[p].results, `${p}: resultados distintos`);
      }
    });
  }
}
