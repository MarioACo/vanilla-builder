// Ofuscación con javascript-obfuscator (dependencia opcional), con ajustes seguros y verificación del resultado.
import * as acorn from 'acorn';
import { shortHash } from './util.js';
import { compareGlobals, moduleShape, checkSyntax } from './jsinfo.js';
import { importOptional } from './optional.js';

// Nunca se activan solos: cambian el comportamiento o rompen código que comparte globales.
const FORCED_SAFE = { renameGlobals: false, renameProperties: false, sourceMap: false, target: 'browser' };

const BASE = {
  compact: true,
  simplify: true,
  identifierNamesGenerator: 'hexadecimal',
  stringArray: true,
  stringArrayRotate: true,
  stringArrayShuffle: true,
  stringArrayIndexShift: true,
  stringArrayWrappersCount: 1,
  stringArrayWrappersType: 'variable',
  stringArrayThreshold: 0.75,
  stringArrayEncoding: [],
  controlFlowFlattening: false,
  deadCodeInjection: false,
  numbersToExpressions: false,
  splitStrings: false,
  transformObjectKeys: false,
  selfDefending: false,
  debugProtection: false,
  disableConsoleOutput: false,
  unicodeEscapeSequence: false,
};

export const PRESETS = {
  // Rápido y casi sin coste de rendimiento.
  low: { ...BASE },
  // Equilibrio recomendado.
  medium: {
    ...BASE,
    controlFlowFlattening: true,
    controlFlowFlatteningThreshold: 0.5,
    deadCodeInjection: true,
    deadCodeInjectionThreshold: 0.2,
    numbersToExpressions: true,
    splitStrings: true,
    splitStringsChunkLength: 10,
    stringArrayEncoding: ['base64'],
    stringArrayWrappersCount: 2,
    stringArrayThreshold: 0.8,
  },
  high: {
    ...BASE,
    controlFlowFlattening: true,
    controlFlowFlatteningThreshold: 0.75,
    deadCodeInjection: true,
    deadCodeInjectionThreshold: 0.4,
    numbersToExpressions: true,
    splitStrings: true,
    splitStringsChunkLength: 5,
    stringArrayEncoding: ['rc4'],
    stringArrayWrappersCount: 5,
    stringArrayWrappersChainedCalls: true,
    stringArrayWrappersParametersMaxCount: 5,
    stringArrayWrappersType: 'function',
    stringArrayThreshold: 1,
    transformObjectKeys: true,
  },
  // Máxima protección: además se defiende de ser formateado o modificado. Más lento y pesado.
  max: {
    ...BASE,
    controlFlowFlattening: true,
    controlFlowFlatteningThreshold: 1,
    deadCodeInjection: true,
    deadCodeInjectionThreshold: 0.5,
    numbersToExpressions: true,
    splitStrings: true,
    splitStringsChunkLength: 3,
    stringArrayEncoding: ['rc4'],
    stringArrayWrappersCount: 5,
    stringArrayWrappersChainedCalls: true,
    stringArrayWrappersParametersMaxCount: 5,
    stringArrayWrappersType: 'function',
    stringArrayCallsTransform: true,
    stringArrayCallsTransformThreshold: 1,
    stringArrayThreshold: 1,
    transformObjectKeys: true,
    selfDefending: true,
  },
};

/** Opciones finales: preset, o preset "low" + opciones del usuario. */
export function resolveObfuscatorOptions(setting) {
  if (!setting) return null;
  if (typeof setting === 'string') return { ...PRESETS[setting], ...FORCED_SAFE };
  const { preset = 'low', ...custom } = setting;
  // El usuario puede activar renameGlobals para módulos bajo su responsabilidad; nunca se aplica a scripts clásicos.
  return { ...(PRESETS[preset] ?? PRESETS.low), ...FORCED_SAFE, ...custom, sourceMap: false };
}

let engine = null;

/** Carga javascript-obfuscator (instalado junto a Builder o en el proyecto). */
export async function ensureObfuscator(projectRoot) {
  if (!engine) {
    const mod = await importOptional('javascript-obfuscator', projectRoot, 'para ofuscar el JavaScript');
    engine = mod.default ?? mod;
  }
  return engine;
}

/** Comentarios legales (/*! ... *\/, @license, @preserve): el ofuscador los borra y se reponen al final. */
function legalComments(code, isModule) {
  const found = [];
  try {
    acorn.parse(code, {
      ecmaVersion: 'latest',
      sourceType: isModule ? 'module' : 'script',
      allowHashBang: true,
      onComment: (block, text) => {
        if (/^!|@license|@preserve/.test(text)) found.push(block ? `/*${text}*/` : `//${text}`);
      },
    });
  } catch {
    return '';
  }
  return [...new Set(found)].join('\n');
}

/**
 * Ofusca un archivo y verifica que siga siendo equivalente en lo que se puede comprobar:
 * - scripts clásicos: mismas globales (más las del ofuscador, con prefijo propio);
 * - módulos: mismas exportaciones, importaciones y atributos de import.
 * Si algo no cuadra devuelve {code: null, reason} y se conserva la versión sin ofuscar.
 */
export function obfuscateSafe(code, { isModule, options, id, globals }) {
  if (!engine) throw new Error('javascript-obfuscator no está cargado (llama antes a ensureObfuscator)');
  const body = code;
  const legal = legalComments(code, isModule);
  const prefix = `_${shortHash(id, 6)}`;
  // Semilla derivada del contenido: la misma entrada produce siempre la misma salida (caché y diffs estables).
  const opts = { ...options, seed: shortHash(`${id}\0${body}`, 12), identifiersPrefix: prefix };
  if (!isModule) opts.renameGlobals = false;
  let out;
  try {
    out = engine.obfuscate(body, opts).getObfuscatedCode();
  } catch (err) {
    return { code: null, reason: `el ofuscador falló (${String(err.message).split('\n')[0]})` };
  }
  if (isModule) {
    const err = checkSyntax(out, true);
    if (err) return { code: null, reason: `resultado inválido (${err})` };
    const a = moduleShape(body);
    const b = moduleShape(out);
    if (!a || !b || a.exports !== b.exports || a.imports !== b.imports)
      return { code: null, reason: 'cambiaron las exportaciones o importaciones del módulo' };
  } else {
    const cmp = compareGlobals(globals, out, prefix);
    if (!cmp.ok) return { code: null, reason: cmp.reason };
  }
  return { code: legal ? `${out}\n${legal}\n` : out };
}
