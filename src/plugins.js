// Plugins: ganchos sencillos para casos que Builder no cubre.
//
//   export default {
//     plugins: [
//       {
//         name: 'version',
//         filter: /\.(html|js)$/,                                  // opcional: a qué archivos se aplica transform
//         transform: ({ path, code }) => code.replaceAll('__VERSION__', '1.2.3'),
//         buildStart: ({ config, mode }) => {},
//         buildEnd: ({ result, outDir }) => {},
//       },
//     ],
//   };
//
// En builder.config.json se nombran paquetes: "plugins": ["mi-plugin", ["otro-plugin", { "opcion": 1 }]].
// Un paquete exporta el objeto plugin o una función (opciones) => plugin.
//
// transform cambia el CÓDIGO FUENTE (HTML, CSS, JS, TS) antes de procesarlo: así el hash, el SRI
// y la verificación final se calculan sobre el resultado del plugin.
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { BuildError } from './util.js';
import { L } from './i18n.js';

export const TRANSFORM_EXT = new Set(['.html', '.htm', '.css', '.js', '.mjs', '.cjs', '.ts', '.mts', '.cts']);
const HOOKS = ['transform', 'buildStart', 'buildEnd'];

/** Errores de validación de la opción "plugins" (antes de cargar paquetes). */
export function validatePlugins(list) {
  if (!Array.isArray(list)) return [L('"plugins" debe ser una lista.', '"plugins" must be a list.')];
  const errors = [];
  list.forEach((p, i) => {
    const ok =
      typeof p === 'string' ||
      (Array.isArray(p) && typeof p[0] === 'string' && p.length <= 2) ||
      (p && typeof p === 'object' && !Array.isArray(p) && typeof p.name === 'string');
    if (!ok)
      errors.push(
        L(
          `"plugins[${i}]" debe ser un nombre de paquete, [nombre, opciones] o un objeto con "name".`,
          `"plugins[${i}]" must be a package name, [name, options] or an object with "name".`,
        ),
      );
    else if (p && typeof p === 'object' && !Array.isArray(p)) {
      for (const k of Object.keys(p))
        if (!['name', 'filter', ...HOOKS].includes(k))
          errors.push(
            L(
              `"plugins[${i}].${k}" no es un gancho conocido (${HOOKS.join(', ')}).`,
              `"plugins[${i}].${k}" is not a known hook (${HOOKS.join(', ')}).`,
            ),
          );
    }
  });
  return errors;
}

/** Carga los plugins nombrados como paquete (desde el proyecto) y devuelve objetos plugin. */
export async function loadPlugins(list, root) {
  const out = [];
  for (const entry of list) {
    if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
      out.push(entry);
      continue;
    }
    const [name, options] = Array.isArray(entry) ? entry : [entry, undefined];
    let mod;
    try {
      const req = createRequire(path.join(root, 'package.json'));
      mod = await import(pathToFileURL(req.resolve(name)).href);
    } catch (err) {
      throw new BuildError(L(`No se pudo cargar el plugin "${name}": ${err.message}`, `Could not load the plugin "${name}": ${err.message}`), [
        L(`Instálalo en el proyecto: npm install --save-dev ${name}`, `Install it in the project: npm install --save-dev ${name}`),
      ]);
    }
    const exported = mod.default ?? mod;
    const plugin = typeof exported === 'function' ? await exported(options ?? {}) : exported;
    if (!plugin || typeof plugin !== 'object' || typeof plugin.name !== 'string')
      throw new BuildError(
        L(
          `El plugin "${name}" debe exportar un objeto con "name" o una función que lo devuelva.`,
          `The plugin "${name}" must export an object with "name" or a function that returns one.`,
        ),
      );
    out.push(plugin);
  }
  return out;
}

async function call(plugin, hook, arg, where = '') {
  try {
    return await plugin[hook](arg);
  } catch (err) {
    throw new BuildError(
      L(
        `El plugin "${plugin.name}" falló en ${hook}${where}: ${err.message}`,
        `The plugin "${plugin.name}" failed in ${hook}${where}: ${err.message}`,
      ),
    );
  }
}

/** Ejecuta un gancho sin valor de retorno (buildStart, buildEnd) en todos los plugins, en orden. */
export async function runHook(plugins, hook, arg) {
  for (const p of plugins) if (typeof p[hook] === 'function') await call(p, hook, arg);
}

/** Pasa el código de un archivo por los transform de todos los plugins, en orden. */
export async function runTransform(plugins, rel, code) {
  let current = code;
  for (const p of plugins) {
    if (typeof p.transform !== 'function') continue;
    if (p.filter instanceof RegExp && !p.filter.test(rel)) continue;
    const r = await call(p, 'transform', { path: rel, code: current }, ` (${rel})`);
    if (typeof r === 'string') current = r;
    else if (r != null)
      throw new BuildError(
        L(
          `El plugin "${p.name}" devolvió algo que no es texto en transform (${rel}).`,
          `The plugin "${p.name}" returned something that is not text from transform (${rel}).`,
        ),
      );
  }
  return current;
}
