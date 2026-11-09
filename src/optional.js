// Carga de dependencias opcionales (ofuscador, terser): solo se instalan si se usan.
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { BuildError } from './util.js';
import { L } from './i18n.js';

const cache = new Map();

/**
 * Importa un paquete opcional buscándolo primero junto a Builder y después en el proyecto
 * (útil si Builder está instalado de forma global).
 */
export async function importOptional(name, projectRoot, purpose) {
  if (cache.has(name)) return cache.get(name);
  let mod = null;
  try {
    mod = await import(name);
  } catch (err) {
    if (!isNotFound(err, name)) throw err;
    try {
      const req = createRequire(path.join(projectRoot ?? process.cwd(), 'package.json'));
      mod = await import(pathToFileURL(req.resolve(name)).href);
    } catch (err2) {
      if (!isNotFound(err2, name)) throw err2;
    }
  }
  if (!mod)
    throw new BuildError(L(`Falta el paquete opcional "${name}" ${purpose}.`, `Missing optional package "${name}" ${purpose}.`), [
      L(`Instálalo una vez con:  npm install --save-dev ${name}`, `Install it once with:  npm install --save-dev ${name}`),
      L(
        'Builder lo carga solo cuando hace falta, por eso no viene incluido (así la instalación base es ligera).',
        'Builder loads it only when needed, so it is not bundled (this keeps the base install small).',
      ),
    ]);
  cache.set(name, mod);
  return mod;
}

function isNotFound(err, name) {
  return (err?.code === 'ERR_MODULE_NOT_FOUND' || err?.code === 'MODULE_NOT_FOUND') && String(err.message).includes(name);
}
