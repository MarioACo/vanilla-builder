// Detección de librerías de terceros (jQuery, Bootstrap, paquetes de npm...).
// No se ofuscan: no aporta nada, las hace más lentas y puede romper su licencia.

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

/**
 * ¿Parece una librería de terceros? Devuelve el motivo o null.
 * @param {string} rel ruta relativa (POSIX)
 * @param {string} code contenido
 */
export function detectDependency(rel, code = '') {
  if (DEP_DIRS.test(rel)) return `está en ${rel.match(DEP_DIRS)[2]}/`;
  const name = rel.split('/').pop();
  if (KNOWN.test(name)) return 'nombre de librería conocida';
  if (MIN_NAME.test(name)) return 'versión ya compilada (.min.js / .umd.js)';
  // Cabecera de librería publicada: /*! o @license con número de versión (jQuery v3.7.1, Bootstrap v5.3.0...).
  // Una cabecera propia sin versión ("/*! Mi app (c) 2026 */") no basta.
  const header = /^\s*\/\*[\s\S]*?\*\//.exec(code.slice(0, 3000))?.[0] ?? '';
  if ((/^\s*\/\*!/.test(header) || /@(license|preserve)\b/.test(header)) && /\bv?\d+\.\d+(\.\d+)?\b/.test(header))
    return 'cabecera de licencia con versión';
  // Código ya minificado: pocas líneas muy largas.
  if (code.length > 4000) {
    const lines = code.split('\n').length;
    if (code.length / lines > 500) return 'código ya minificado';
  }
  return null;
}
