// Pasada de terser con verificación. Sin estado: se usa igual en el hilo principal y en los hilos de trabajo.
import { compareGlobals, moduleShape } from './jsinfo.js';

/**
 * Comprime con terser y solo acepta el resultado si es más pequeño y conserva las globales (scripts)
 * o las exportaciones/importaciones (módulos). Devuelve el código original si no compensa.
 */
export async function terserMinify(terser, code, { isModule, level, globals, keepNames = false }) {
  const ecma = Math.min(2020, Math.max(5, level ?? 2020));
  let out;
  try {
    const r = await terser.minify(code, {
      module: isModule,
      toplevel: isModule,
      ecma,
      compress: { passes: 3, ecma, module: isModule, toplevel: isModule },
      mangle: { toplevel: isModule },
      keep_fnames: keepNames,
      keep_classnames: keepNames,
      format: { comments: /^!|@license|@preserve/i, ascii_only: true, ecma },
    });
    out = r.code;
  } catch {
    return code;
  }
  if (!out || out.length >= code.trimEnd().length) return code;
  if (isModule) {
    const a = moduleShape(code);
    const b = moduleShape(out);
    if (!a || !b || a.exports !== b.exports || a.imports !== b.imports) return code;
  } else if (!globals || !compareGlobals(globals, out).ok) return code;
  return out;
}
