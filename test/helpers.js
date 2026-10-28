// Utilidades de prueba: copiar fixtures, compilar y comparar el comportamiento real en un navegador.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { build } from '../src/index.js';
import { startServer } from '../src/server.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const FIXTURES = path.join(HERE, 'fixtures');

/** Copia un fixture a una carpeta temporal para no ensuciar el repositorio. */
export function copyFixture(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `vb-${name}-`));
  copyDirSync(path.join(FIXTURES, name), dir);
  return dir;
}

function copyDirSync(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    if (e.isDirectory()) copyDirSync(path.join(src, e.name), path.join(dest, e.name));
    else fs.copyFileSync(path.join(src, e.name), path.join(dest, e.name));
  }
}

export function tempDir(prefix = 'vb-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function writeFiles(dir, files) {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
}

export const read = (dir, rel) => fs.readFileSync(path.join(dir, rel), 'utf8');
export const exists = (dir, rel) => fs.existsSync(path.join(dir, rel));

export async function buildDir(dir, overrides = {}, opts = {}) {
  return build({ dir, overrides, ...opts });
}

/**
 * Compila con la CLI usando otro ejecutable de Node (BUILDER_NODE=ruta/a/node).
 * Sirve para compilar con Node 16 y comprobar el resultado en el navegador con un Node moderno.
 */
export function buildWithCli(dir, overrides = {}) {
  const node = process.env.BUILDER_NODE;
  if (!node) return buildDir(dir, overrides);
  fs.writeFileSync(path.join(dir, 'builder.config.json'), JSON.stringify(overrides));
  const r = spawnSync(node, [path.join(HERE, '..', 'bin', 'builder.js'), 'build', dir, '--json'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const out = JSON.parse(r.stdout || '{}');
  if (r.status !== 0 || !out.ok) throw new Error(`La CLI con ${node} falló: ${out.error ?? r.stderr}\n${(out.details ?? []).join('\n')}`);
  return out;
}

/** Busca un Chromium para las pruebas de navegador. */
export function findBrowser() {
  const candidates = [
    process.env.BUILDER_CHROMIUM,
    path.resolve(HERE, '../../TicketsTofact/bench/.chromium/chrome-win/chrome.exe'),
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].filter(Boolean);
  return candidates.find((p) => fs.existsSync(p)) ?? null;
}

let chromium = null;
async function loadPlaywright() {
  if (chromium) return chromium;
  try {
    ({ chromium } = await import('playwright-core'));
  } catch {
    chromium = null;
  }
  return chromium;
}

/**
 * Abre cada página servida desde `dir` y devuelve window.__results, errores de consola
 * y peticiones fallidas. Cada carpeta usa su propio servidor y su propio perfil de navegador.
 */
export async function runInBrowser(dir, pages, { timeout = 15000 } = {}) {
  const pw = await loadPlaywright();
  const exe = findBrowser();
  if (!pw || !exe) return null;
  const srv = await startServer({ dir, port: 0 });
  const browser = await pw.launch({ executablePath: exe, headless: true, args: ['--no-first-run', '--disable-extensions'] });
  const out = {};
  try {
    for (const p of pages) {
      const context = await browser.newContext({ serviceWorkers: 'allow' });
      const page = await context.newPage();
      const errors = [];
      const failed = [];
      page.on('pageerror', (e) => errors.push(e.message));
      // Los 404 se registran con su URL en `failed`; el navegador pide /favicon.ico por su cuenta.
      page.on('console', (m) => {
        if (m.type() === 'error' && !m.text().startsWith('Failed to load resource')) errors.push(m.text());
      });
      const implicit = (url) => url === `${srv.url}favicon.ico`;
      page.on('requestfailed', (r) => {
        if (!implicit(r.url())) failed.push(`${r.url().replace(srv.url, '/')} (${r.failure()?.errorText})`);
      });
      page.on('response', (r) => {
        if (r.status() >= 400 && !implicit(r.url())) failed.push(`${r.url().replace(srv.url, '/')} (${r.status()})`);
      });
      await page.goto(srv.url + p, { waitUntil: 'load' });
      let results = null;
      try {
        await page.waitForFunction(() => window.__done === true, null, { timeout });
        results = await page.evaluate(() => window.__results);
        // Cada carpeta se sirve en un puerto distinto: se normalizan las URLs absolutas.
        results = JSON.parse(
          JSON.stringify(results ?? null)
            .split(srv.url)
            .join('/'),
        );
      } catch (err) {
        errors.push(`no terminó: ${err.message.split('\n')[0]}`);
      }
      out[p] = { results, errors, failed };
      await context.close();
    }
  } finally {
    await browser.close();
    await srv.close();
  }
  return out;
}
