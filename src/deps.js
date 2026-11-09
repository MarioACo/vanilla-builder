// Detección de librerías de terceros (jQuery, Bootstrap, paquetes de npm...).
// No se ofuscan: no aporta nada, las hace más lentas y puede romper su licencia.
import { L } from './i18n.js';

const DEP_DIRS = /(^|\/)(node_modules|bower_components|jspm_packages|web_modules|vendors?|third[-_]?party|external|externals)\//i;
const MIN_NAME = /[.-](min|prod|production)\.m?js$|\.umd(\.min)?\.m?js$/i;
// Nombres de librerías conocidas, con o sin versión: jquery-3.7.1.js, bootstrap.bundle.js, chart.umd.js...
const KNOWN = new RegExp(
  `^(${[
    'jquery(?:[.-]ui)?',
    'zepto',
    'bootstrap',
    'popper',
    '@popperjs',
    'lodash',
    'underscore',
    'moment(?:-with-locales)?',
    'dayjs',
    'luxon',
    'd3',
    'three',
    'vue',
    'react',
    'react-dom',
    'preact',
    'angular',
    'alpine',
    'alpinejs',
    'htmx',
    'axios',
    'gsap',
    'swiper',
    'leaflet',
    'mapbox-gl',
    'sweetalert2?',
    'toastr',
    'select2',
    'datatables',
    'jquery\\.dataTables',
    'fullcalendar',
    'prism',
    'marked',
    'dompurify',
    'handlebars',
    'mustache',
    'backbone',
    'knockout',
    'socket\\.io',
    'pdf(?:\\.worker)?',
    'tinymce',
    'ckeditor',
    'quill',
    'lottie',
    'fontawesome',
    'modernizr',
    'core-js',
    'regenerator-runtime',
    'tailwind(?:css)?',
    'bulma',
    'uikit',
    'materialize',
    'fancybox',
    'slick',
    'owl\\.carousel',
    'isotope',
    'masonry',
    'imagesloaded',
    'inputmask',
    'flatpickr',
    'pikaday',
    'nouislider',
    'requirejs',
    'es-module-shims',
    'workbox-[\\w-]+',
    'firebase(?:-[\\w-]+)?',
    'plyr',
    'howler',
    'pixi',
    'phaser',
    'konva',
    'echarts',
    'apexcharts',
    'highcharts',
    'plotly',
    'mathjax',
    'katex',
    'mermaid',
    'codemirror',
    'monaco',
    'xlsx',
    'jszip',
    'filesaver',
    'jspdf',
    'html2canvas',
    'qrcode',
    'crypto-js',
    'immutable',
    'rxjs',
    'mobx',
    'redux',
    'i18next',
    'intl-tel-input',
    'libphonenumber',
    'cropper',
    'dropzone',
    'tippy',
    'micromodal',
    'glightbox',
    'splide',
    'flickity',
    'scrollreveal',
    'locomotive-scroll',
    'lenis',
    'barba',
    'swup',
  ].join('|')})(?:[.@_-][\\w.-]*)?\\.m?js$`,
  'i',
);

// Marca escrita por el usuario en el primer comentario del archivo.
const PRAGMA = /@builder-(dependency|dependencia|own|propio)\b/i;
// Envoltorio UMD/AMD/CommonJS: el formato con el que se publican las librerías para usarlas con <script>.
const UMD = [
  /typeof\s+define\s*===?\s*["']function["']\s*&&\s*define\.amd/,
  /typeof\s+exports\s*===?\s*["']object["']\s*&&\s*typeof\s+module\s*!==?\s*["']undefined["']/,
  /typeof\s+module\s*===?\s*["']object["']\s*&&\s*(?:typeof\s+)?module\.exports/,
];

/**
 * Marca explícita en el propio archivo: un comentario inicial con @builder-dependency o @builder-own.
 * @returns {'dependency'|'own'|null}
 */
export function dependencyPragma(code = '') {
  const head = code.slice(0, 2000);
  const comment = /^\s*(?:\/\*[\s\S]*?\*\/|\/\/[^\n]*)/.exec(head)?.[0] ?? '';
  const m = PRAGMA.exec(comment);
  if (!m) return null;
  return /^(dependency|dependencia)$/i.test(m[1]) ? 'dependency' : 'own';
}

/** Nombre "de paquete" de un archivo: jquery-3.7.1.min.js → jquery, chart.umd.js → chart. */
export function packageLikeName(fileName) {
  return fileName
    .toLowerCase()
    .replace(/\.(m?js|cjs)$/, '')
    .replace(/[.-](min|prod|production|umd|esm|es|module|cjs|iife|bundle|browser|global|dist)\b/g, '')
    .replace(/[@.-]v?\d+(\.\d+){1,3}(-[\w.]+)?$/, '')
    .replace(/[.-](min|prod|production|umd|esm|es|module|cjs|iife|bundle|browser|global|dist)$/g, '');
}

/**
 * Nombres de los paquetes declarados en el package.json del proyecto, normalizados
 * (chart.js → chart, @popperjs/core → popperjs), para reconocer copias a mano en js/.
 * @returns {Map<string, string>} nombre normalizado → nombre en package.json
 */
export function packageNames(pkg) {
  const names = new Map();
  // devDependencies no: suelen ser herramientas (eslint, prettier…) y darían falsos positivos.
  for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
    for (const full of Object.keys(pkg?.[field] ?? {})) {
      const lower = full.toLowerCase();
      const [scope, bare] = lower.startsWith('@') ? lower.slice(1).split('/') : [null, lower];
      for (const n of [bare, scope]) {
        if (!n || n.length < 3) continue;
        for (const key of [n, n.replace(/\.js$/, '')]) if (!names.has(key)) names.set(key, full);
      }
    }
  }
  // Nombres demasiado genéricos para concluir nada solo por el nombre del archivo.
  for (const generic of ['core', 'utils', 'util', 'app', 'main', 'index', 'common', 'types', 'lib', 'api']) names.delete(generic);
  return names;
}

/**
 * ¿Parece una librería de terceros? Devuelve el motivo o null.
 * @param {string} rel ruta relativa (POSIX)
 * @param {string} code contenido
 * @param {{packages?: Map<string, string>}} [hints] nombres de package.json del proyecto
 */
export function detectDependency(rel, code = '', hints = {}) {
  if (DEP_DIRS.test(rel)) return L(`está en ${rel.match(DEP_DIRS)[2]}/`, `in ${rel.match(DEP_DIRS)[2]}/`);
  const name = rel.split('/').pop();
  if (KNOWN.test(name)) return L('nombre de librería conocida', 'well-known library name');
  if (MIN_NAME.test(name)) return L('versión ya compilada (.min.js / .umd.js)', 'already compiled build (.min.js / .umd.js)');
  const pkgName = packageLikeName(name);
  if (hints.packages?.has(pkgName))
    return L(
      `se llama como el paquete "${hints.packages.get(pkgName)}" de tu package.json`,
      `named like the "${hints.packages.get(pkgName)}" package in your package.json`,
    );
  const edges = code.length > 8000 ? code.slice(0, 5000) + code.slice(-3000) : code;
  if (UMD.some((re) => re.test(edges))) return L('envoltorio UMD/AMD (formato de librería publicada)', 'UMD/AMD wrapper (published library format)');
  // Cabecera de librería publicada: /*! o @license con número de versión (jQuery v3.7.1, Bootstrap v5.3.0...).
  // Una cabecera propia sin versión ("/*! Mi app (c) 2026 */") no basta.
  const header = /^\s*\/\*[\s\S]*?\*\//.exec(code.slice(0, 3000))?.[0] ?? '';
  if ((/^\s*\/\*!/.test(header) || /@(license|preserve)\b/.test(header)) && /\bv?\d+\.\d+(\.\d+)?\b/.test(header))
    return L('cabecera de licencia con versión', 'license header with a version');
  // Código ya minificado: pocas líneas muy largas.
  if (code.length > 4000) {
    const lines = code.split('\n').length;
    if (code.length / lines > 500) return L('código ya minificado', 'already minified code');
  }
  return null;
}
