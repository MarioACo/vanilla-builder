// Hilo de trabajo: ofusca o comprime con terser fuera del hilo principal.
import { parentPort, workerData } from 'node:worker_threads';
import { ensureObfuscator, obfuscateSafe } from './obfuscate.js';
import { importOptional } from './optional.js';
import { terserMinify } from './tersercore.js';
import { jsImports } from './jsimports.js';

let terser = null;

parentPort.on('message', async ({ id, kind, payload }) => {
  try {
    let result;
    if (kind === 'obfuscate') {
      await ensureObfuscator(workerData.root);
      result = obfuscateSafe(payload.code, payload.opts);
    } else if (kind === 'terser') {
      terser ??= await importOptional('terser', workerData.root, 'para la compresión máxima');
      result = await terserMinify(terser, payload.code, payload.opts);
    } else if (kind === 'imports') {
      result = jsImports(payload.code, payload.opts.isModule);
    } else throw new Error(`tarea desconocida: ${kind}`);
    parentPort.postMessage({ id, result });
  } catch (err) {
    parentPort.postMessage({ id, error: String(err?.message ?? err) });
  }
});
