// HTML: extrae referencias con su posición exacta, aplica ediciones puntuales y minifica con verificación.
import { parse } from 'parse5';
import { minify } from 'html-minifier-terser';

const JS_TYPES = new Set([
  '',
  'text/javascript',
  'application/javascript',
  'text/ecmascript',
  'application/ecmascript',
  'application/x-javascript',
  'application/x-ecmascript',
  'text/x-javascript',
  'text/x-ecmascript',
  'text/jscript',
  'text/livescript',
  'text/javascript1.0',
  'text/javascript1.1',
  'text/javascript1.2',
  'text/javascript1.3',
  'text/javascript1.4',
  'text/javascript1.5',
]);
const JSON_TYPES = new Set(['application/json', 'application/ld+json', 'speculationrules']);

export function scriptKind(typeAttr) {
  const t = (typeAttr ?? '').trim().toLowerCase().split(';')[0].trim();
  if (JS_TYPES.has(t)) return 'classic';
  if (t === 'module') return 'module';
  if (t === 'importmap') return 'importmap';
  if (JSON_TYPES.has(t)) return 'json';
  return 'other';
}

// Atributos con URLs a recursos. "page": puede ser otra página; "soft": no rompe la página si falta.
const ELEMENT_ATTRS = {
  img: [['src'], ['srcset', 'srcset']],
  source: [['src'], ['srcset', 'srcset']],
  video: [['src'], ['poster']],
  audio: [['src']],
  track: [['src']],
  embed: [['src']],
  object: [['data']],
  input: [['src']],
  iframe: [['src', 'page']],
  frame: [['src', 'page']],
  a: [['href', 'soft-page']],
  area: [['href', 'soft-page']],
  image: [['href'], ['xlink:href']],
  use: [['href'], ['xlink:href']],
  feimage: [['href'], ['xlink:href']],
  body: [['background']],
  table: [['background']],
  td: [['background']],
  th: [['background']],
  html: [['manifest']],
};
const SOFT_DATA_ATTRS = new Set(['data-src', 'data-srcset', 'data-bg', 'data-background', 'data-background-image', 'data-poster', 'data-href']);
const META_IMAGE = /^(og:(image|video|audio)(:url|:secure_url)?|twitter:(image|player)(:src)?|msapplication-(tileimage|config|square\d+x\d+logo|wide\d+x\d+logo))$/i;
const LINK_ASSET_RELS = new Set(['icon', 'shortcut', 'apple-touch-icon', 'apple-touch-icon-precomposed', 'apple-touch-startup-image', 'mask-icon', 'manifest', 'image_src', 'fluid-icon']);
const LINK_PAGE_RELS = new Set(['canonical', 'alternate', 'next', 'prev', 'prerender', 'help', 'license', 'author']);

const attrName = (a) => (a.prefix ? `${a.prefix}:${a.name}` : a.name);

function getAttrs(el) {
  const map = new Map();
  for (const a of el.attrs ?? []) {
    const name = attrName(a);
    if (!map.has(name)) map.set(name, a.value);
  }
  return map;
}

function attrLoc(el, name) {
  const l = el.sourceCodeLocation?.attrs?.[name];
  return l ? { start: l.startOffset, end: l.endOffset } : null;
}

const hasLoc = (el) => !!el?.sourceCodeLocation?.startTag;

/**
 * Analiza un HTML y devuelve sus elementos relevantes en orden de documento.
 */
export function parseHtml(text) {
  const doc = parse(text, { sourceCodeLocationInfo: true, scriptingEnabled: false });
  const htmlEl = doc.childNodes.find((n) => n.nodeName === 'html');
  const head = htmlEl?.childNodes.find((n) => n.nodeName === 'head');
  const body = htmlEl?.childNodes.find((n) => n.nodeName === 'body');
  const isDocument = doc.childNodes.some((n) => n.nodeName === '#documentType') || hasLoc(htmlEl) || hasLoc(head) || hasLoc(body);
  const model = { isDocument, base: null, refs: [], scripts: [], styles: [], links: [], styleAttrs: [], importMaps: [] };

  const visit = (node, parent, index, inTemplate) => {
    if (node.nodeName === '#text' || node.nodeName === '#comment' || node.nodeName === '#documentType') return;
    const tag = node.tagName?.toLowerCase();
    if (tag) handleElement(node, tag, parent, index, inTemplate);
    const kids = node.nodeName === 'template' && node.content ? node.content.childNodes : node.childNodes ?? [];
    const childInTemplate = inTemplate || node.nodeName === 'template';
    for (let i = 0; i < kids.length; i++) visit(kids[i], node.nodeName === 'template' ? node.content : node, i, childInTemplate);
  };

  const pushRef = (el, name, value, kind, extra = {}) => {
    const loc = attrLoc(el, name);
    if (!loc) return;
    model.refs.push({ el, attr: name, value, kind, ...loc, ...extra });
  };

  function handleElement(el, tag, parent, index, inTemplate) {
    const loc = el.sourceCodeLocation;
    if (!loc) return;
    const attrs = getAttrs(el);
    if (attrs.has('style') && attrs.get('style').trim()) {
      const l = attrLoc(el, 'style');
      if (l) model.styleAttrs.push({ el, value: attrs.get('style'), ...l });
    }
    for (const [name, value] of attrs) {
      if (SOFT_DATA_ATTRS.has(name)) pushRef(el, name, value, name.endsWith('srcset') ? 'srcset' : 'asset', { soft: true });
    }
    if (tag === 'base' && attrs.has('href') && !model.base && !inTemplate) {
      model.base = attrs.get('href');
      return;
    }
    if (tag === 'script') {
      const content =
        loc.startTag && loc.endTag ? { start: loc.startTag.endOffset, end: loc.endTag.startOffset, code: text.slice(loc.startTag.endOffset, loc.endTag.startOffset) } : null;
      const kind = scriptKind(attrs.get('type'));
      const item = { el, attrs, kind, parent, index, inTemplate, start: loc.startOffset, end: loc.endOffset, src: null, inline: null };
      if (attrs.has('src')) item.src = { value: attrs.get('src'), ...attrLoc(el, 'src') };
      else if (content) item.inline = content;
      if (kind === 'importmap' && item.inline) model.importMaps.push(item);
      model.scripts.push(item);
      return;
    }
    if (tag === 'style') {
      const t = (attrs.get('type') ?? '').trim().toLowerCase();
      if ((t === '' || t === 'text/css') && loc.startTag && loc.endTag)
        model.styles.push({ el, attrs, start: loc.startTag.endOffset, end: loc.endTag.startOffset, code: text.slice(loc.startTag.endOffset, loc.endTag.startOffset) });
      return;
    }
    if (tag === 'link') {
      const rels = (attrs.get('rel') ?? '').toLowerCase().split(/\s+/).filter(Boolean);
      if (!attrs.has('href')) return;
      const href = { value: attrs.get('href'), ...attrLoc(el, 'href') };
      const item = { el, attrs, rels, href, start: loc.startOffset, end: loc.endOffset, inTemplate };
      if (rels.includes('stylesheet')) item.type = 'stylesheet';
      else if (rels.some((r) => r === 'modulepreload' || r === 'preload' || r === 'prefetch')) item.type = 'preload';
      else if (rels.some((r) => LINK_ASSET_RELS.has(r))) item.type = 'asset';
      else if (rels.some((r) => LINK_PAGE_RELS.has(r))) item.type = 'page';
      else item.type = 'other';
      model.links.push(item);
      if (attrs.has('imagesrcset')) pushRef(el, 'imagesrcset', attrs.get('imagesrcset'), 'srcset', { soft: true });
      return;
    }
    if (tag === 'meta') {
      const key = attrs.get('property') ?? attrs.get('name') ?? '';
      if (META_IMAGE.test(key) && attrs.has('content')) pushRef(el, 'content', attrs.get('content'), 'asset', { soft: true });
      const equiv = (attrs.get('http-equiv') ?? '').toLowerCase();
      if (equiv === 'refresh' && attrs.has('content')) {
        const m = /url\s*=\s*['"]?([^'"]+)/i.exec(attrs.get('content'));
        if (m) model.refs.push({ el, attr: 'content', value: m[1].trim(), kind: 'page', soft: true, ...attrLoc(el, 'content') });
      }
      return;
    }
    for (const [name, mode] of ELEMENT_ATTRS[tag] ?? []) {
      if (!attrs.has(name)) continue;
      const value = attrs.get(name);
      if (mode === 'srcset') pushRef(el, name, value, 'srcset');
      else if (mode === 'page') pushRef(el, name, value, 'page');
      else if (mode === 'soft-page') pushRef(el, name, value, 'page', { soft: true });
      else pushRef(el, name, value, 'asset');
    }
  }

  for (let i = 0; i < doc.childNodes.length; i++) visit(doc.childNodes[i], doc, i, false);
  return model;
}

/** ¿Entre dos hermanos solo hay espacios en blanco o comentarios? */
export function adjacentSiblings(a, b) {
  if (!a || !b || a.parent !== b.parent || a.index >= b.index) return false;
  const kids = a.parent.childNodes ?? [];
  for (let i = a.index + 1; i < b.index; i++) {
    const n = kids[i];
    if (n.nodeName === '#comment') continue;
    if (n.nodeName === '#text' && !n.value.trim()) continue;
    return false;
  }
  return true;
}

export const escapeAttr = (v) => v.replace(/&/g, '&amp;').replace(/"/g, '&quot;');

export const attrText = (name, value) => (value == null ? '' : `${name}="${escapeAttr(value)}"`);

/** Aplica ediciones {start, end, text} sobre el texto original. */
export function applyEdits(text, edits) {
  const sorted = [...edits].sort((a, b) => b.start - a.start || b.end - a.end);
  let out = text;
  let limit = Infinity;
  for (const e of sorted) {
    if (e.end > limit) throw new Error(`Ediciones superpuestas en la posición ${e.start}`);
    out = out.slice(0, e.start) + e.text + out.slice(e.end);
    limit = e.start;
  }
  return out;
}

/** Evita que el contenido de un <script> inline cierre la etiqueta antes de tiempo. */
export function escapeInlineScript(code) {
  return code.replace(/<\/(script)/gi, '<\\/$1').replace(/<!--/g, '<\\!--');
}

export function escapeInlineStyle(code) {
  return code.replace(/<\/(style)/gi, '<\\/$1');
}

const WS = /^[ \t\n\r\f]+|[ \t\n\r\f]+$/g;
const INVISIBLE = new Set(['script', 'style', 'link', 'meta']);
const BOOLEAN_ATTRS = new Set(
  'allowfullscreen async autofocus autoplay checked compact controls declare default defaultchecked defaultmuted defaultselected defer disabled enabled formnovalidate hidden indeterminate inert ismap itemscope loop multiple muted nohref noresize noshade novalidate nowrap open pauseonexit readonly required reversed scoped seamless selected sortable truespeed typemustmatch visible'.split(' '),
);

/** Normaliza solo las diferencias de atributos que el estándar considera equivalentes. */
function normalizeAttr(tag, attrs, name, value) {
  let v = value.replace(WS, '');
  // Atributo booleano: "" y su propio nombre son los dos valores válidos y equivalentes.
  if (BOOLEAN_ATTRS.has(name) && (v === '' || v.toLowerCase() === name)) return '';
  if (name === 'class') return v.split(/[ \t\n\r\f]+/).join(' ');
  if (name.startsWith('on')) return v.replace(/^javascript:\s*/i, '');
  if (name === 'style') return v.replace(/\s*;$/, ';');
  if (name === 'srcset' || name === 'imagesrcset') {
    return v
      .split(/\s+,\s*|\s*,\s+/)
      .map((c) => {
        const m = c.match(/\s+([1-9][0-9]*w|[0-9]+(?:\.[0-9]+)?x)$/);
        if (!m) return c;
        const num = +m[1].slice(0, -1);
        const suffix = m[1].slice(-1);
        return c.slice(0, -m[0].length) + (num !== 1 || suffix !== 'x' ? ` ${num}${suffix}` : '');
      })
      .join(', ');
  }
  if (tag === 'meta' && name === 'content') {
    const get = (n) => attrs.find((a) => a.name === n)?.value?.toLowerCase();
    if (get('name') === 'viewport') return v.replace(/\s+/g, '').replace(/[0-9]+\.[0-9]+/g, (n) => String(+n));
    if (get('http-equiv') === 'content-security-policy') return v.replace(/\s+/g, ' ');
  }
  if (tag === 'script' && name === 'type') v = v.replace(/\s*;\s*/g, ';');
  return v;
}

/** Firma estructural: elementos + atributos + texto normalizado. Sirve para comprobar que minificar no perdió nada. */
export function htmlSignature(text) {
  const doc = parse(text, { scriptingEnabled: false });
  const parts = [];
  let textBuf = '';
  // El texto se acumula a través de comentarios (al quitarlos se unen los textos vecinos).
  const flush = (parentTag, raw) => {
    if (!textBuf) return;
    if (raw) parts.push(`#${textBuf}`);
    else {
      const t = textBuf.replace(/[ \t\n\r\f]+/g, ' ');
      // Espacios entre elementos de <head>/<html> no se muestran.
      if (t.trim() || !(parentTag === 'head' || parentTag === 'html' || parentTag === '#document')) parts.push(`#${t}`);
    }
    textBuf = '';
  };
  const visit = (n, raw, parentTag) => {
    if (n.nodeName === '#text') {
      textBuf += n.value;
      return;
    }
    if (n.nodeName === '#comment' || n.nodeName === '#documentType') return;
    const tag = n.tagName;
    const attrs = n.attrs ?? [];
    const open = `<${tag}${attrs.map((a) => ` ${attrName(a)}=${JSON.stringify(normalizeAttr(tag, attrs, attrName(a), a.value))}`).join('')}>`;
    if (!raw && INVISIBLE.has(tag)) {
      // No se muestran: los espacios de ambos lados se funden en uno, igual que en el navegador.
      parts.push(`${open}${(n.childNodes ?? []).map((k) => k.value ?? '').join('')}</${tag}>`);
      return;
    }
    flush(parentTag, raw);
    parts.push(open);
    const kids = tag === 'template' && n.content ? n.content.childNodes : n.childNodes ?? [];
    const keepRaw = raw || tag === 'pre' || tag === 'textarea' || tag === 'script' || tag === 'style' || tag === 'xmp' || tag === 'plaintext';
    for (const k of kids) visit(k, keepRaw, tag);
    flush(tag, keepRaw);
    parts.push(`</${tag}>`);
  };
  for (const n of doc.childNodes) visit(n, false, '#document');
  flush('#document', false);
  return parts.join('');
}

export function detectPreWhitespace(cssText) {
  return /white-space\s*:\s*(pre|pre-wrap|pre-line|break-spaces)\b|white-space-collapse\s*:\s*(preserve|break-spaces)/i.test(cssText);
}

/**
 * Minifica HTML de forma conservadora y verifica que el resultado tenga exactamente
 * los mismos elementos, atributos y texto visible. Si no, devuelve el original.
 */
export async function minifyHtml(text, { removeComments, collapseWhitespace }) {
  // El contenido de <script> y <style> ya viene minificado (o es una plantilla): se protege tal cual.
  const raw = [];
  const nonce = Math.random().toString(36).slice(2, 10);
  const spans = [];
  const collect = (n) => {
    const tag = n.tagName;
    const loc = n.sourceCodeLocation;
    if ((tag === 'script' || tag === 'style') && loc?.startTag && loc?.endTag && loc.endTag.startOffset > loc.startTag.endOffset)
      spans.push([loc.startTag.endOffset, loc.endTag.startOffset]);
    const kids = tag === 'template' && n.content ? n.content.childNodes : n.childNodes ?? [];
    for (const k of kids) collect(k);
  };
  collect(parse(text, { sourceCodeLocationInfo: true, scriptingEnabled: false }));
  let protectedText = text;
  for (const [s, e] of spans.sort((a, b) => b[0] - a[0])) {
    const token = `__vbraw${nonce}_${raw.length}__`;
    raw.push([token, text.slice(s, e)]);
    protectedText = protectedText.slice(0, s) + token + protectedText.slice(e);
  }
  let out;
  try {
    out = await minify(protectedText, {
      collapseWhitespace,
      conservativeCollapse: true,
      removeComments,
      ignoreCustomComments: [/^!/, /^\s*#/, /^\s*\/?ko\b/, /^\s*esi\b/, /^\s*google_ad_section/, /^\s*(?:build|endbuild)\b/],
      processConditionalComments: false,
      // Sin esto el minificador convierte `defer` en `defer="defer"`.
      collapseBooleanAttributes: true,
      removeAttributeQuotes: false,
      removeRedundantAttributes: false,
      removeScriptTypeAttributes: false,
      removeStyleLinkTypeAttributes: false,
      removeEmptyAttributes: false,
      removeEmptyElements: false,
      removeOptionalTags: false,
      removeTagWhitespace: false,
      useShortDoctype: false,
      decodeEntities: false,
      keepClosingSlash: true,
      caseSensitive: true,
      minifyCSS: false,
      minifyJS: false,
      minifyURLs: false,
      sortAttributes: false,
      sortClassName: false,
      includeAutoGeneratedTags: false,
      continueOnParseError: true,
      html5: true,
    });
  } catch (err) {
    return { code: text, note: `no se pudo minificar el HTML (${String(err.message).split('\n')[0]})` };
  }
  for (const [token, content] of raw) {
    const at = out.indexOf(token);
    if (at === -1 || out.indexOf(token, at + 1) !== -1) return { code: text, note: 'no se pudo proteger un <script>/<style>; se deja sin minificar' };
    out = out.slice(0, at) + content + out.slice(at + token.length);
  }
  const before = htmlSignature(text);
  const after = htmlSignature(out);
  if (before !== after) {
    let i = 0;
    while (i < before.length && before[i] === after[i]) i++;
    const near = before.slice(Math.max(0, i - 40), i + 40).replace(/\s+/g, ' ');
    return { code: text, note: `la minificación cambiaba la estructura cerca de «${near}»; se deja sin minificar` };
  }
  return { code: out };
}
