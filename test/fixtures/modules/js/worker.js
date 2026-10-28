import { doblar } from './lib/math.js';

self.onmessage = (e) => {
  self.postMessage(doblar(e.data));
};
