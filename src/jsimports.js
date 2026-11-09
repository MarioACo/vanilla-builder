// Rutas importadas por un JS ya generado (para verificar que existen en la salida).
import * as acorn from 'acorn';
import * as walk from 'acorn-walk';

/**
 * Reescribe los imports relativos de un archivo TypeScript ya transpilado para que funcionen en el navegador:
 * "./x.ts" → "./x.js" (tras compilar existe con extensión .js) y "./x" → "./x.js" o "./x/index.js"
 * según `complete(spec)`, que devuelve la ruta completa o null. Si el código no se puede leer, se devuelve igual.
 */
export function rewriteTsImports(code, complete = () => null) {
  let ast;
  try {
    ast = acorn.parse(code, { ecmaVersion: 'latest', sourceType: 'module', allowHashBang: true });
  } catch {
    return code;
  }
  const edits = [];
  const consider = (src) => {
    if (src?.type !== 'Literal' || typeof src.value !== 'string' || !/^\.{1,2}\//.test(src.value)) return;
    let spec = src.value;
    if (/\.(m|c)?ts$/i.test(spec)) spec = spec.replace(/\.(m|c)?ts$/i, (_, p) => `.${(p ?? '').toLowerCase()}js`);
    else if (!/\.[a-z0-9]+$/i.test(spec.split('/').pop())) spec = complete(spec) ?? spec;
    if (spec !== src.value) edits.push({ start: src.start, end: src.end, text: JSON.stringify(spec) });
  };
  const isImportMetaUrl = (m) =>
    m?.type === 'MemberExpression' && m.object.type === 'MetaProperty' && m.object.meta.name === 'import' && m.property.name === 'url';
  walk.full(ast, (n) => {
    if (n.type === 'ImportDeclaration' || n.type === 'ExportAllDeclaration' || n.type === 'ExportNamedDeclaration') consider(n.source);
    else if (n.type === 'ImportExpression') consider(n.source);
    // new URL('./worker.ts', import.meta.url): workers y recursos cargados por ruta.
    else if (n.type === 'NewExpression' && n.callee.type === 'Identifier' && n.callee.name === 'URL' && isImportMetaUrl(n.arguments[1]))
      consider(n.arguments[0]);
  });
  let out = code;
  for (const e of edits.sort((a, b) => b.start - a.start)) out = out.slice(0, e.start) + e.text + out.slice(e.end);
  return out;
}

/** Devuelve {imports} o {error} si el código no es JavaScript válido. */
export function jsImports(code, isModule) {
  let ast;
  try {
    ast = acorn.parse(code, { ecmaVersion: 'latest', sourceType: isModule ? 'module' : 'script', allowHashBang: true });
  } catch (err) {
    return { error: err.message };
  }
  const imports = [];
  walk.full(ast, (n) => {
    if ((n.type === 'ImportDeclaration' || n.type === 'ExportAllDeclaration' || n.type === 'ExportNamedDeclaration') && n.source)
      imports.push(n.source.value);
    if (n.type === 'ImportExpression' && n.source.type === 'Literal' && typeof n.source.value === 'string') imports.push(n.source.value);
  });
  return { imports };
}
