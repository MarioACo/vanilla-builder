import { store, incrementar } from './lib/store.js';
import { formatear } from 'utils/format.js';
import { logoUrl } from './lib/assets.js';
import datos from '../data/datos.json' with { type: 'json' };
import hoja from '../css/hoja.css' with { type: 'css' };

incrementar();
document.adoptedStyleSheets = [...document.adoptedStyleSheets, hoja];

const resultados = {
  count: store.count,
  formato: formatear(1234.5),
  logo: logoUrl,
  datos: datos.items.length,
  cssModule: hoja instanceof CSSStyleSheet,
  colorDesdeModuloCss: getComputedStyle(document.getElementById('out')).borderTopColor,
};

const lazy = await import('./lazy.js');
resultados.lazy = lazy.valor();

const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
resultados.worker = await new Promise((resolve) => {
  worker.onmessage = (e) => resolve(e.data);
  worker.postMessage(21);
});

resultados.logoCarga = await fetch(logoUrl).then((r) => r.ok);
resultados.inlineModule = window.__inlineModule;
resultados.mismoStore = store.inline === true;
resultados.colorCss = getComputedStyle(document.getElementById('out')).color;
resultados.margen = getComputedStyle(document.body).marginTop;

const registro = await navigator.serviceWorker.register('./sw.js');
resultados.sw = await Promise.race([
  navigator.serviceWorker.ready.then(() => 'activo'),
  new Promise((r) => setTimeout(() => r(registro.installing?.state ?? registro.waiting?.state ?? 'sin activar'), 8000)),
]);
const cache = await caches.open('v1');
resultados.precache = (await cache.keys()).length;

window.__results = resultados;
window.__done = true;
