// Prueba definitiva de "sin pérdida": el sitio compilado debe comportarse exactamente igual
// que el original en un navegador real (mismos resultados, sin errores ni 404).
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { copyFixture, buildWithCli, runInBrowser, findBrowser } from './helpers.js';

const skip = findBrowser() ? false : 'no hay Chromium disponible (define BUILDER_CHROMIUM)';

const SCENARIOS = [
  { fixture: 'classic', pages: ['index.html', 'about.html'] },
  { fixture: 'modules', pages: ['index.html', 'admin/index.html'] },
  { fixture: 'npm', pages: ['index.html'] },
];
const VARIANTS = [
  { name: 'por defecto', overrides: {} },
  { name: 'ofuscación alta + hash', overrides: { obfuscate: 'high', hash: true } },
  { name: 'ofuscación max', overrides: { obfuscate: 'max' } },
  { name: 'compresión máxima (terser) + .gz/.br', overrides: { js: { minifier: 'terser' }, compress: true } },
  { name: 'sin minificar', overrides: { js: { minify: false }, css: { minify: false }, html: { minify: false } } },
];

for (const { fixture, pages } of SCENARIOS) {
  for (const v of VARIANTS) {
    const via = process.env.BUILDER_NODE ? ` [compilado con ${process.env.BUILDER_NODE_LABEL ?? 'otro Node'}]` : '';
    test(`${fixture} (${v.name})${via}: se comporta igual que el original`, { skip, timeout: 180000 }, async () => {
      const dir = copyFixture(fixture);
      const src = await runInBrowser(dir, pages);
      await buildWithCli(dir, v.overrides);
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

test('dev: un cambio solo de CSS recarga las hojas de estilos sin recargar la página', { skip, timeout: 60000 }, async () => {
  const fs = await import('node:fs');
  const { chromium } = await import('playwright-core');
  const { startServer } = await import('../src/server.js');
  const { tempDir, writeFiles } = await import('./helpers.js');
  const dir = tempDir();
  writeFiles(dir, {
    'index.html': '<!doctype html><html><head><link rel="stylesheet" href="app.css"></head><body><p id="t">hola</p></body></html>',
    'app.css': '#t { color: rgb(255, 0, 0); }',
  });
  const srv = await startServer({ dir, port: 0, liveReload: true });
  const browser = await chromium.launch({ executablePath: findBrowser(), headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(srv.url);
    await page.waitForFunction(() => getComputedStyle(document.getElementById('t')).color === 'rgb(255, 0, 0)');
    await page.evaluate(() => {
      window.estado = 42; // se perdería con una recarga completa
    });
    // Espera a que el EventSource esté conectado antes de enviar el aviso.
    await page.waitForTimeout(300);
    fs.writeFileSync(path.join(dir, 'app.css'), '#t { color: rgb(0, 128, 0); }');
    srv.reloadCss();
    await page.waitForFunction(() => getComputedStyle(document.getElementById('t')).color === 'rgb(0, 128, 0)', null, { timeout: 5000 });
    assert.equal(await page.evaluate(() => window.estado), 42, 'la página no se recargó');
    assert.equal(await page.evaluate(() => document.querySelectorAll('link[rel=stylesheet]').length), 1, 'no quedan hojas duplicadas');
  } finally {
    await browser.close();
    await srv.close();
  }
});
