// Mide el builder sobre el sitio sintético en varias configuraciones (mediana de N ejecuciones).
// Uso: npm run bench [-- --scale 2 --runs 5 --only default,obfuscate]
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { build } from '../src/index.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : def;
};
const scale = arg('scale', '1');
const runs = Number(arg('runs', '3'));
// Fuera del proyecto: carpetas sincronizadas (OneDrive, Dropbox) o antivirus distorsionan la medida.
const site = path.join(os.tmpdir(), 'vanilla-builder-bench');

const VARIANTS = {
  default: {},
  obfuscate: { obfuscate: 'medium' },
  'hash+compress': { hash: true, compress: true },
  terser: { js: { minifier: 'terser' } },
};
const only = arg('only', '')?.split(',').filter(Boolean);

execFileSync(process.execPath, [path.join(HERE, 'generate.mjs'), site, scale], { stdio: 'inherit' });
// Opciones extra para comparar, ej. --set '{"workers":0}'
const extra = JSON.parse(arg('set', '{}'));

async function measure(overrides) {
  const times = [];
  let last;
  for (let i = 0; i < runs; i++) {
    fs.rmSync(path.join(site, 'dist'), { recursive: true, force: true });
    const t = process.hrtime.bigint();
    last = await build({ dir: site, overrides });
    times.push(Number(process.hrtime.bigint() - t) / 1e6);
  }
  times.sort((a, b) => a - b);
  return { median: Math.round(times[Math.floor(times.length / 2)]), last };
}

const rows = [];
for (const [name, variant] of Object.entries(VARIANTS)) {
  if (only?.length && !only.includes(name)) continue;
  // En frío: sin caché (primera compilación). En caliente: caché llena (compilaciones siguientes, CI con caché).
  const cold = await measure({ ...variant, ...extra, cache: false });
  await build({ dir: site, overrides: { ...variant, ...extra, cache: true } });
  const warm = await measure({ ...variant, ...extra, cache: true });
  rows.push({
    variante: name,
    'en frío (ms)': cold.median,
    'con caché (ms)': warm.median,
    archivos: cold.last.outputs.size,
    avisos: cold.last.warnings.length,
  });
}
console.table(rows);
console.log(`Mediana de ${runs} ejecuciones · Node ${process.version} · ${os.cpus()[0].model.trim()} (${os.cpus().length} hilos)`);
