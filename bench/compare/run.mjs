// Compara vanilla-builder con Parcel y Vite sobre los mismos sitios.
//  1. Corrección: los sitios de prueba del repo (test/fixtures) se compilan con cada herramienta y se abren
//     en Chromium junto al original: mismos resultados (window.__results), sin errores y sin 404.
//  2. Tiempo y tamaño: el sitio sintético de bench/generate.mjs, en frío (sin caché).
// Uso (desde bench/compare, tras npm install):  node run.mjs [--scale 1] [--runs 3]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawnSync, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build as viteBuild } from 'vite';
import { build as vbBuild } from '../../src/index.js';
import { copyFixture, runInBrowser, findBrowser } from '../../test/helpers.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const arg = (n, d) => (process.argv.includes(`--${n}`) ? process.argv[process.argv.indexOf(`--${n}`) + 1] : d);
const RUNS = Number(arg('runs', '3'));
const SCALE = arg('scale', '1');
const PARCEL_BIN = path.join(path.dirname(require.resolve('parcel/package.json')), 'lib', 'bin.js');
const versions = {
  'vanilla-builder': JSON.parse(fs.readFileSync(path.join(HERE, '..', '..', 'package.json'), 'utf8')).version,
  parcel: JSON.parse(fs.readFileSync(require.resolve('parcel/package.json'), 'utf8')).version,
  vite: JSON.parse(fs.readFileSync(require.resolve('vite/package.json'), 'utf8')).version,
};

const htmlFiles = (dir) => {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === 'dist' || e.name.startsWith('.')) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.html')) out.push(path.relative(dir, p).split(path.sep).join('/'));
    }
  };
  walk(dir);
  return out;
};

// Cada herramienta con su configuración "de fábrica" para un sitio de varias páginas: todas las páginas como entradas.
const TOOLS = {
  'vanilla-builder': async (src, out) => {
    await vbBuild({ dir: src, overrides: { outDir: out, cache: false } });
  },
  parcel: async (src, out) => {
    const r = spawnSync(
      process.execPath,
      [PARCEL_BIN, 'build', ...htmlFiles(src), '--dist-dir', out, '--no-cache', '--no-source-maps', '--log-level', 'error'],
      {
        cwd: src,
        encoding: 'utf8',
        maxBuffer: 1 << 26,
      },
    );
    if (r.status !== 0) throw new Error((r.stderr || r.stdout || '').trim().split('\n').slice(0, 3).join(' '));
  },
  vite: async (src, out) => {
    const input = Object.fromEntries(htmlFiles(src).map((h) => [h.replace(/\W/g, '_'), path.join(src, h)]));
    await viteBuild({ root: src, configFile: false, logLevel: 'silent', build: { outDir: out, emptyOutDir: true, rollupOptions: { input } } });
  },
};

const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `vb-cmp-${name.replace(/[^\w-]+/g, '-')}-`));

function sizeOf(dir) {
  let bytes = 0;
  let gzip = 0;
  let files = 0;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (!/\.(map|gz|br)$/.test(e.name) && e.name !== '.builder-manifest.json') {
        const buf = fs.readFileSync(p);
        files++;
        bytes += buf.length;
        gzip += /\.(html|js|mjs|css|json|svg)$/.test(e.name) ? zlib.gzipSync(buf, { level: 9 }).length : buf.length;
      }
    }
  };
  walk(dir);
  return { bytes, gzip, files };
}

const kb = (n) => `${(n / 1024).toFixed(1)} KB`;
// eslint-disable-next-line no-control-regex
const clean = (s) =>
  (
    String(s)
      .replace(/\x1b\[[0-9;]*m/g, '')
      .replace(/Build failed with \d+ errors?:\s*/i, '')
      .split('\n')
      .find((l) => l.trim()) ?? ''
  )
    // Rutas de la carpeta temporal (y del usuario): solo interesa la ruta dentro del sitio.
    .replace(/(?:[A-Za-z]:)?[^\s"'()]*?vb-[\w-]+?-[A-Za-z0-9]{6}[\\/]/g, '')
    .trim();

/** Abre algunas páginas del sitio grande y cuenta errores y peticiones fallidas (sin esperar resultados). */
async function smoke(dir, pages) {
  const { chromium } = await import('playwright-core');
  const { startServer } = await import('../../src/server.js');
  const srv = await startServer({ dir, port: 0 });
  const browser = await chromium.launch({ executablePath: findBrowser(), headless: true });
  const problems = [];
  try {
    for (const p of pages) {
      const page = await browser.newPage();
      page.on('pageerror', (e) => problems.push(`${p}: ${e.message.slice(0, 80)}`));
      page.on(
        'response',
        (r) => r.status() >= 400 && !r.url().endsWith('favicon.ico') && problems.push(`${p}: ${r.status()} ${r.url().replace(srv.url, '/')}`),
      );
      await page.goto(srv.url + p, { waitUntil: 'load' });
      await page.waitForTimeout(300);
      const out = await page.evaluate(() => document.querySelector('#out')?.textContent ?? '');
      if (!out) problems.push(`${p}: the module script did not run (#out is empty)`);
      await page.close();
    }
  } finally {
    await browser.close();
    await srv.close();
  }
  return problems;
}

// ---------- 1. Corrección ----------
const SCENARIOS = [
  { fixture: 'classic', pages: ['index.html', 'about.html'] },
  { fixture: 'modules', pages: ['index.html', 'admin/index.html'] },
  { fixture: 'npm', pages: ['index.html'] },
];

function compare(orig, built, page) {
  const problems = [];
  const a = orig[page];
  const b = built[page];
  if (JSON.stringify(a.results) !== JSON.stringify(b.results)) {
    const keys = new Set([...Object.keys(a.results ?? {}), ...Object.keys(b.results ?? {})]);
    const diff = [...keys].filter((k) => JSON.stringify(a.results?.[k]) !== JSON.stringify(b.results?.[k]));
    problems.push(`different results: ${diff.slice(0, 4).join(', ') || 'page did not finish'}`);
  }
  for (const e of b.errors.filter((e) => !a.errors.includes(e))) problems.push(`error: ${e.slice(0, 90)}`);
  for (const f of b.failed.filter((f) => !a.failed.includes(f))) problems.push(`failed request: ${f.slice(0, 90)}`);
  return problems;
}

const correctness = [];
if (!findBrowser()) console.log('No Chromium found (set BUILDER_CHROMIUM): skipping correctness.');
else
  for (const { fixture, pages } of SCENARIOS) {
    const src = copyFixture(fixture);
    const orig = await runInBrowser(src, pages);
    for (const [tool, run] of Object.entries(TOOLS)) {
      const out = path.join(tmp(tool), 'out');
      const row = { fixture, tool, pages: pages.length, ok: 0, problems: [] };
      try {
        await run(copyFixture(fixture), out);
        const built = await runInBrowser(out, pages);
        for (const p of pages) {
          const pr = compare(orig, built, p);
          if (pr.length) row.problems.push(...pr.map((x) => `${p}: ${x}`));
          else row.ok++;
        }
      } catch (err) {
        row.problems.push(`build failed: ${clean(err.message).slice(0, 160)}`);
      }
      correctness.push(row);
      console.log(
        `${fixture.padEnd(8)} ${tool.padEnd(16)} ${row.ok}/${row.pages} pages identical${row.problems.length ? ` — ${row.problems[0]}` : ''}`,
      );
    }
  }

// ---------- 2. Tiempo y tamaño ----------
const site = path.join(os.tmpdir(), 'vanilla-builder-compare-site');
execFileSync(process.execPath, [path.join(HERE, '..', 'generate.mjs'), site, SCALE], { stdio: 'inherit' });
const sourceSize = sizeOf(site);
// Un tamaño solo es comparable si el sitio funciona: se abren algunas páginas de cada salida.
const SAMPLE = ['index.html', 'page1.html', 'page20.html'];
const canSmoke = !!findBrowser();
const sourceProblems = canSmoke ? await smoke(site, SAMPLE) : [];
if (sourceProblems.length) console.log(`The source site itself has problems: ${sourceProblems.join('; ')}`);
const perf = [];
// Misma comparación, pero sin publicar lo que nada referencia (lo que hacen Parcel y Vite).
const PERF_TOOLS = {
  ...TOOLS,
  'vanilla-builder (unreferenced: skip)': async (src, out) => {
    await vbBuild({ dir: src, overrides: { outDir: out, cache: false, unreferenced: 'skip' } });
  },
};
for (const [tool, run] of Object.entries(PERF_TOOLS)) {
  const times = [];
  let size = null;
  let error = null;
  let lastOut = null;
  for (let i = 0; i < RUNS && !error; i++) {
    const out = path.join(tmp(tool), 'out');
    const t = process.hrtime.bigint();
    try {
      await run(site, out);
      times.push(Number(process.hrtime.bigint() - t) / 1e6);
      size = sizeOf(out);
      lastOut = out;
    } catch (err) {
      error = clean(err.message).slice(0, 160);
    }
  }
  times.sort((a, b) => a - b);
  const problems = lastOut && canSmoke ? await smoke(lastOut, SAMPLE) : null;
  perf.push({ tool, median: times[Math.floor(times.length / 2)], size, error, problems });
  console.log(
    `${tool.padEnd(16)} ${error ? `failed: ${error}` : `${Math.round(times[Math.floor(times.length / 2)])} ms, ${size.files} files, ${kb(size.bytes)} (${kb(size.gzip)} gzip)`}` +
      (problems ? ` — ${problems.length ? `${problems.length} problem(s), e.g. ${problems[0]}` : 'sample pages work'}` : ''),
  );
}

// ---------- Informe ----------
const lines = [
  '# vanilla-builder vs Parcel vs Vite',
  '',
  `Run on ${new Date().toISOString().slice(0, 10)} · ${os.cpus()[0].model.trim()} · Node ${process.version} · ${os.platform()}`,
  `Versions: vanilla-builder ${versions['vanilla-builder']}, Parcel ${versions.parcel}, Vite ${versions.vite}. Default settings; every HTML page passed as an entry.`,
  '',
  '## Does the built site behave like the original?',
  '',
  'Each test site is opened in Chromium before and after building. A page counts as identical when it reports the same results, with no new console errors and no new failed requests.',
  '',
  '| Site | vanilla-builder | Parcel | Vite |',
  '| --- | --- | --- | --- |',
];
for (const { fixture } of SCENARIOS) {
  const cell = (tool) => {
    const r = correctness.find((x) => x.fixture === fixture && x.tool === tool);
    return r ? `${r.ok === r.pages ? '✅' : '❌'} ${r.ok}/${r.pages}` : '—';
  };
  lines.push(`| \`${fixture}\` | ${cell('vanilla-builder')} | ${cell('parcel')} | ${cell('vite')} |`);
}
const issues = correctness.filter((r) => r.problems.length);
if (issues.length) {
  lines.push('', '<details><summary>What broke</summary>', '');
  for (const r of issues) for (const p of r.problems.slice(0, 6)) lines.push(`- **${r.tool}**, \`${r.fixture}\`: ${p.replace(/\|/g, '\\|')}`);
  lines.push('', '</details>');
}
lines.push(
  '',
  `## Build time and size (generated site, ${RUNS} runs, cold, no cache)`,
  '',
  `Source: ${sourceSize.files} files, ${kb(sourceSize.bytes)}.`,
  '',
  `Sample pages checked in Chromium: ${SAMPLE.join(', ')} (no page errors, no failed requests, the module script ran).`,
  '',
  '| Tool | Time (median) | Output files | Output size | gzip (text files) | Sample pages work? |',
  '| --- | ---: | ---: | ---: | ---: | --- |',
);
for (const p of perf) {
  const works =
    p.problems == null ? '—' : p.problems.length ? `❌ ${p.problems.length} problem(s), e.g. ${p.problems[0].replace(/\|/g, '\\|')}` : '✅';
  lines.push(
    p.error
      ? `| ${p.tool} | failed: ${p.error.replace(/\|/g, '\\|')} | | | | ❌ |`
      : `| ${p.tool} | ${(p.median / 1000).toFixed(2)} s | ${p.size.files} | ${kb(p.size.bytes)} | ${kb(p.size.gzip)} | ${works} |`,
  );
}
lines.push(
  '',
  'Output files and size are only comparable between tools whose sample pages work: a smaller output can mean files were left out.',
  'vanilla-builder also publishes files nothing references (`unreferenced: "process"`), which the others drop; set `"unreferenced": "skip"` to compare like for like.',
);
lines.push('', 'Reproduce: `cd bench/compare && npm install && node run.mjs`.', '');
fs.writeFileSync(path.join(HERE, 'RESULTS.md'), lines.join('\n'));
console.log(`\nWritten ${path.join(HERE, 'RESULTS.md')}`);
