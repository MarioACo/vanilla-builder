// Análisis estático de JavaScript con acorn: nivel de sintaxis, globales, workers y rutas.
import * as acorn from 'acorn';
import * as walk from 'acorn-walk';

const VERSIONS = [5, 2015, 2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025, 2026];
const LATEST = 'latest';

function parse(code, sourceType, ecmaVersion) {
  return acorn.parse(code, { ecmaVersion, sourceType, allowHashBang: true });
}

function tryParse(code, sourceType, ecmaVersion) {
  try {
    return parse(code, sourceType, ecmaVersion);
  } catch {
    return null;
  }
}

/** Nivel ES mínimo con el que el código se puede leer (búsqueda binaria). */
function detectLevel(code, sourceType) {
  const list = sourceType === 'module' ? VERSIONS.slice(1) : VERSIONS;
  let lo = 0;
  let hi = list.length - 1;
  if (!tryParse(code, sourceType, list[hi])) return null;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (tryParse(code, sourceType, list[mid])) hi = mid;
    else lo = mid + 1;
  }
  return list[lo];
}

const isStr = (n) => n && ((n.type === 'Literal' && typeof n.value === 'string') || (n.type === 'TemplateLiteral' && n.expressions.length === 0));
const strVal = (n) => (n.type === 'Literal' ? n.value : n.quasis[0].value.cooked);
const isImportMetaUrl = (n) =>
  n?.type === 'MemberExpression' && n.object.type === 'MetaProperty' && n.object.meta.name === 'import' && !n.computed && n.property.name === 'url';
const propName = (n) => (n.type === 'MemberExpression' && !n.computed ? n.property.name : n.type === 'Identifier' ? n.name : null);
const PATHLIKE = /^[^\s<>"'`]{1,260}\.[a-z0-9]{1,10}(?:[?#][^\s]*)?$/i;

function patternNames(node, out) {
  if (!node) return;
  switch (node.type) {
    case 'Identifier':
      out.push(node.name);
      break;
    case 'ObjectPattern':
      for (const p of node.properties) patternNames(p.type === 'RestElement' ? p.argument : p.value, out);
      break;
    case 'ArrayPattern':
      for (const e of node.elements) patternNames(e, out);
      break;
    case 'RestElement':
      patternNames(node.argument, out);
      break;
    case 'AssignmentPattern':
      patternNames(node.left, out);
      break;
  }
}

/** Nombres que un script clásico crea en el ámbito global, con su tipo (var | lex). */
function globalBindings(ast, strict) {
  const top = new Map();
  for (const stmt of ast.body) {
    if (stmt.type === 'VariableDeclaration' && stmt.kind !== 'var') {
      const names = [];
      for (const d of stmt.declarations) patternNames(d.id, names);
      for (const n of names) top.set(n, 'lex');
    } else if (stmt.type === 'ClassDeclaration') top.set(stmt.id.name, 'lex');
  }
  // var y function se elevan al ámbito global desde cualquier bloque (sin cruzar funciones).
  walk.recursive(ast, null, {
    Function() {},
    StaticBlock() {},
    FunctionDeclaration(node) {
      // En modo estricto las funciones dentro de bloques no son globales.
      if (!top.has(node.id.name) && (!strict || ast.body.includes(node))) top.set(node.id.name, 'var');
    },
    VariableDeclaration(node, st, c) {
      if (node.kind === 'var') {
        const names = [];
        for (const d of node.declarations) patternNames(d.id, names);
        for (const n of names) if (!top.has(n)) top.set(n, 'var');
      }
      for (const d of node.declarations) if (d.init) c(d.init, st);
    },
  });
  return top;
}

/**
 * Analiza un archivo JS.
 * @param {string} code
 * @param {{module?: boolean|'auto'}} [opts]
 */
export function analyzeJs(code, opts = {}) {
  const want = opts.module ?? 'auto';
  let sourceType = want === true ? 'module' : 'script';
  let ast = tryParse(code, sourceType, LATEST);
  if (!ast && want === 'auto') {
    sourceType = 'module';
    ast = tryParse(code, 'module', LATEST);
  }
  if (!ast) {
    let error;
    try {
      parse(code, sourceType, LATEST);
    } catch (err) {
      error = err.message;
    }
    return { ok: false, error, isModule: sourceType === 'module' };
  }
  const isModule = sourceType === 'module';
  const strict = isModule || ast.body.some((s) => s.directive === 'use strict');
  const info = {
    ok: true,
    isModule,
    level: detectLevel(code, sourceType),
    strict,
    top: isModule ? new Map() : globalBindings(ast, strict),
    imports: [],
    workers: [],
    urls: [],
    unsafeUrls: [],
    dynamicImports: 0,
    strings: new Set(),
    usesCurrentScript: false,
    usesDocumentWrite: false,
    hasImportMeta: false,
    hasModuleSyntax: false,
  };
  const addWorker = (arg, kind, optsNode) => {
    if (!arg) return;
    let spec = null;
    let viaUrl = false;
    handled.add(arg);
    if (isStr(arg)) spec = strVal(arg);
    else if (arg.type === 'NewExpression' && propName(arg.callee) === 'URL' && isStr(arg.arguments[0]) && isImportMetaUrl(arg.arguments[1])) {
      spec = strVal(arg.arguments[0]);
      viaUrl = true;
    }
    const module =
      optsNode?.type === 'ObjectExpression' &&
      optsNode.properties.some((p) => p.type === 'Property' && (p.key.name === 'type' || p.key.value === 'type') && isStr(p.value) && strVal(p.value) === 'module');
    info.workers.push({ spec, kind, module: !!module, viaUrl });
  };
  // Textos que ya son rutas de import/worker/new URL: no cuentan como "mencionados".
  const handled = new Set();
  const candidates = [];
  walk.full(ast, (node) => {
    switch (node.type) {
      case 'ImportDeclaration':
      case 'ExportAllDeclaration':
      case 'ExportNamedDeclaration':
        info.hasModuleSyntax = true;
        if (node.source) {
          handled.add(node.source);
          info.imports.push({ spec: node.source.value, kind: 'static' });
        }
        break;
      case 'ExportDefaultDeclaration':
        info.hasModuleSyntax = true;
        break;
      case 'ImportExpression':
        info.dynamicImports++;
        handled.add(node.source);
        if (isStr(node.source)) info.imports.push({ spec: strVal(node.source), kind: 'dynamic' });
        else info.imports.push({ spec: null, kind: 'dynamic' });
        break;
      case 'MetaProperty':
        if (node.meta.name === 'import') info.hasImportMeta = true;
        break;
      case 'MemberExpression':
        if (node.object.type === 'Identifier' && node.object.name === 'document' && !node.computed) {
          if (node.property.name === 'currentScript') info.usesCurrentScript = true;
          if (node.property.name === 'write' || node.property.name === 'writeln') info.usesDocumentWrite = true;
        }
        break;
      case 'NewExpression': {
        const name = propName(node.callee);
        if (name === 'Worker' || name === 'SharedWorker') addWorker(node.arguments[0], name === 'Worker' ? 'worker' : 'sharedworker', node.arguments[1]);
        else if (name === 'URL' && isImportMetaUrl(node.arguments[1])) {
          const a = node.arguments[0];
          handled.add(a);
          if (isStr(a)) info.urls.push({ spec: strVal(a), start: a.start, end: a.end });
          else info.unsafeUrls.push(code.slice(node.start, Math.min(node.end, node.start + 80)));
        }
        break;
      }
      case 'CallExpression': {
        const callee = node.callee;
        if (callee.type === 'Identifier' && callee.name === 'importScripts') {
          for (const a of node.arguments) {
            handled.add(a);
            if (isStr(a)) info.workers.push({ spec: strVal(a), kind: 'importScripts', module: false, viaUrl: false });
          }
        } else if (callee.type === 'MemberExpression' && propName(callee) === 'register' && callee.object.type === 'MemberExpression' && propName(callee.object) === 'serviceWorker') {
          addWorker(node.arguments[0], 'serviceworker', node.arguments[1]);
        }
        break;
      }
      case 'Literal':
        if (typeof node.value === 'string' && PATHLIKE.test(node.value)) candidates.push([node, node.value]);
        break;
      case 'TemplateLiteral':
        if (node.expressions.length === 0 && PATHLIKE.test(node.quasis[0].value.cooked ?? '')) candidates.push([node, node.quasis[0].value.cooked]);
        break;
    }
  });
  for (const [node, value] of candidates) if (!handled.has(node)) info.strings.add(value);
  if (!info.usesCurrentScript && /document\s*(?:\.\s*currentScript|\[\s*['"`]currentScript)/.test(code)) info.usesCurrentScript = true;
  return info;
}

/** Comprueba que el JS de salida sea sintácticamente válido. */
export function checkSyntax(code, isModule) {
  try {
    parse(code, isModule ? 'module' : 'script', LATEST);
    return null;
  } catch (err) {
    return err.message;
  }
}

/**
 * Compara las globales de un script antes y después de transformarlo.
 * `allowPrefix` permite nombres nuevos con ese prefijo (los que añade el ofuscador).
 */
export function compareGlobals(before, afterCode, allowPrefix = null) {
  const after = analyzeJs(afterCode, { module: false });
  if (!after.ok) return { ok: false, reason: `el resultado no es JS válido (${after.error})` };
  for (const [name, kind] of before) {
    if (!after.top.has(name)) return { ok: false, reason: `desaparece la global "${name}"` };
    if (after.top.get(name) !== kind) return { ok: false, reason: `la global "${name}" cambia de tipo (${kind} → ${after.top.get(name)})` };
  }
  for (const name of after.top.keys()) {
    if (!before.has(name) && !(allowPrefix && name.startsWith(allowPrefix)))
      return { ok: false, reason: `aparece una global nueva "${name}" que podría chocar con otros scripts` };
  }
  return { ok: true };
}

/** Exportaciones e importaciones de un módulo, para comparar antes/después de ofuscar. */
export function moduleShape(code) {
  const ast = tryParse(code, 'module', LATEST);
  if (!ast) return null;
  const exports = [];
  const imports = [];
  // Los atributos (with { type: 'css' }) forman parte del import: perderlos cambia cómo se carga.
  const src = (s) => `${s.source.value}${(s.attributes ?? []).map((a) => `|${a.key.name ?? a.key.value}=${a.value.value}`).join('')}`;
  for (const s of ast.body) {
    if (s.type === 'ExportNamedDeclaration') {
      for (const sp of s.specifiers) exports.push(sp.exported.name ?? sp.exported.value);
      if (s.declaration) {
        if (s.declaration.id) exports.push(s.declaration.id.name);
        else if (s.declaration.declarations) for (const d of s.declaration.declarations) patternNames(d.id, exports);
      }
      if (s.source) imports.push(src(s));
    } else if (s.type === 'ExportDefaultDeclaration') exports.push('default');
    else if (s.type === 'ExportAllDeclaration') {
      exports.push(`*${s.exported ? `:${s.exported.name ?? s.exported.value}` : ''}`);
      imports.push(src(s));
    } else if (s.type === 'ImportDeclaration') imports.push(src(s));
  }
  return { exports: exports.sort().join(','), imports: imports.sort().join(',') };
}

export { VERSIONS };
