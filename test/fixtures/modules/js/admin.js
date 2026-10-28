import { store, incrementar } from './lib/store.js';
import { doblar } from './lib/math.js';

incrementar();
incrementar();

window.__results = {
  count: store.count,
  doble: doblar(store.count),
  color: getComputedStyle(document.querySelector('h1')).color,
};
window.__done = true;
