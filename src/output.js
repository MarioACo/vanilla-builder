// Salida: se escribe primero en una carpeta temporal y solo se reemplaza dist/ si todo salió bien.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BuildError, isInside, retryFs } from './util.js';

export const MANIFEST = '.builder-manifest.json';

/** Comprueba que outDir sea un destino seguro antes de tocar nada. */
export function assertSafeOutDir(cfg, { force = false } = {}) {
  const out = path.resolve(cfg.outDir);
  const root = path.resolve(cfg.root);
  const parsed = path.parse(out);
  const same = (a, b) => path.relative(a, b) === '';
  if (same(out, root)) throw new BuildError('"outDir" no puede ser la propia carpeta del proyecto: se borraría el código fuente.');
  if (isInside(out, root)) throw new BuildError(`"outDir" (${out}) contiene al proyecto; se borraría el código fuente.`);
  if (same(out, parsed.root)) throw new BuildError('"outDir" no puede ser la raíz de una unidad.');
  if (same(out, os.homedir())) throw new BuildError('"outDir" no puede ser tu carpeta de usuario.');
  if (!cfg.clean || force) return;
  if (fs.existsSync(out)) {
    if (!fs.statSync(out).isDirectory()) throw new BuildError(`"outDir" existe y no es una carpeta: ${out}`);
    const entries = fs.readdirSync(out);
    if (entries.length && !entries.includes(MANIFEST))
      throw new BuildError(
        `La carpeta de salida ${out} ya tiene archivos y no la creó Builder. No la borro para no perder datos.`,
        ['Elige otra carpeta con --out, vacíala tú mismo o usa --force si estás seguro.'],
      );
  }
}

/** Escribe todos los archivos en una carpeta temporal junto a outDir. */
export async function writeStaging(cfg, outputs) {
  const out = path.resolve(cfg.outDir);
  const staging = path.join(path.dirname(out), `.${path.basename(out)}.builder-tmp-${process.pid}-${Date.now().toString(36)}`);
  await fs.promises.mkdir(staging, { recursive: true });
  const dirs = new Set();
  for (const rel of outputs.keys()) dirs.add(path.dirname(path.join(staging, rel)));
  for (const d of [...dirs].sort()) await fs.promises.mkdir(d, { recursive: true });
  const list = [...outputs.entries()];
  const CONCURRENCY = 16;
  for (let i = 0; i < list.length; i += CONCURRENCY) {
    await Promise.all(
      list.slice(i, i + CONCURRENCY).map(async ([rel, o]) => {
        const dest = path.join(staging, rel);
        if (o.copyFrom) await retryFs(() => fs.promises.copyFile(o.copyFrom, dest));
        else await retryFs(() => fs.promises.writeFile(dest, o.data));
      }),
    );
  }
  return staging;
}

export async function writeManifest(dir, manifest) {
  await fs.promises.writeFile(path.join(dir, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);
}

async function rmrf(dir) {
  await retryFs(() => fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
}

/**
 * Sustituye outDir por la carpeta temporal. Si outDir no se puede renombrar (bloqueos de OneDrive/antivirus),
 * se vacía su contenido y se copia el nuevo.
 */
export async function swapIntoPlace(cfg, staging) {
  const out = path.resolve(cfg.outDir);
  const old = path.join(path.dirname(out), `.${path.basename(out)}.builder-old-${process.pid}-${Date.now().toString(36)}`);
  const exists = fs.existsSync(out);
  if (exists && !cfg.clean) {
    // Sin limpiar: se copian encima los archivos nuevos y se conserva lo demás.
    await fs.promises.cp(staging, out, { recursive: true, force: true });
    await rmrf(staging);
    return;
  }
  if (exists) {
    try {
      await retryFs(() => fs.promises.rename(out, old));
    } catch {
      for (const name of await fs.promises.readdir(out)) await rmrf(path.join(out, name));
      await fs.promises.cp(staging, out, { recursive: true, force: true });
      await rmrf(staging);
      return;
    }
  }
  try {
    await retryFs(() => fs.promises.rename(staging, out));
  } catch (err) {
    try {
      await fs.promises.cp(staging, out, { recursive: true, force: true });
      await rmrf(staging);
    } catch (copyErr) {
      if (exists) await retryFs(() => fs.promises.rename(old, out)).catch(() => {});
      throw new BuildError(`No pude colocar la salida en ${out}: ${copyErr.message ?? err.message}`);
    }
  }
  if (exists) await rmrf(old).catch(() => {});
}

export async function discardStaging(staging) {
  if (staging) await rmrf(staging).catch(() => {});
}
