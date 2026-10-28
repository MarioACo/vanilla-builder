// Ofuscación con javascript-obfuscator, con ajustes seguros y verificación del resultado.
import JavaScriptObfuscator from 'javascript-obfuscator';
import { shortHash } from './util.js';
import { compareGlobals, moduleShape, checkSyntax } from './jsinfo.js';

// Nunca se activan por defecto: cambian el comportamiento o rompen código que comparte globales.
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
  low: { ...BASE },
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
};

/** Opciones finales: preset o preset "low" + opciones del usuario. */
export function resolveObfuscatorOptions(setting) {
  if (!setting) return null;
  if (typeof setting === 'string') return { ...PRESETS[setting], ...FORCED_SAFE };
  const { preset = 'low', ...custom } = setting;
  const user = { ...custom };
  // El usuario puede activar renameGlobals para módulos bajo su responsabilidad; nunca para scripts clásicos.
  return { ...PRESETS[preset] ?? PRESETS.low, ...FORCED_SAFE, ...user, sourceMap: false };
}

/**
 * Ofusca un archivo y verifica que siga siendo equivalente en lo que se puede comprobar:
 * - scripts clásicos: mismas globales (más las del ofuscador, con prefijo propio);
 * - módulos: mismas exportaciones e importaciones.
 * Si algo no cuadra devuelve {code: null, reason} y se conserva la versión sin ofuscar.
 */
export function obfuscateSafe(code, { isModule, options, id, globals }) {
  const prefix = `_${shortHash(id, 6)}`;
  const opts = { ...options, seed: shortHash(`${id}\0${code}`, 12), identifiersPrefix: prefix };
  if (!isModule) opts.renameGlobals = false;
  let out;
  try {
    out = JavaScriptObfuscator.obfuscate(code, opts).getObfuscatedCode();
  } catch (err) {
    return { code: null, reason: `el ofuscador falló (${err.message.split('\n')[0]})` };
  }
  if (isModule) {
    const err = checkSyntax(out, true);
    if (err) return { code: null, reason: `resultado inválido (${err})` };
    const a = moduleShape(code);
    const b = moduleShape(out);
    if (!a || !b || a.exports !== b.exports || a.imports !== b.imports)
      return { code: null, reason: 'cambiaron las exportaciones o importaciones del módulo' };
  } else {
    const cmp = compareGlobals(globals, out, prefix);
    if (!cmp.ok) return { code: null, reason: cmp.reason };
  }
  return { code: out };
}
