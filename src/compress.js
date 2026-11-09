// gzip y brotli asíncronos (en el pool de hilos de libuv) y calculados una sola vez por contenido:
// el informe de tamaños y los archivos .gz/.br precomprimidos comparten el mismo resultado.
import zlib from 'node:zlib';
import { promisify } from 'node:util';

const gzip = promisify(zlib.gzip);
const brotli = promisify(zlib.brotliCompress);
const cache = new WeakMap();

function entry(buf) {
  let e = cache.get(buf);
  if (!e) cache.set(buf, (e = {}));
  return e;
}

export function gzipOf(buf) {
  const e = entry(buf);
  return (e.gzip ??= gzip(buf, { level: 9 }));
}

export function brotliOf(buf) {
  const e = entry(buf);
  return (e.brotli ??= brotli(buf, {
    params: {
      [zlib.constants.BROTLI_PARAM_QUALITY]: 11,
      [zlib.constants.BROTLI_PARAM_MODE]: zlib.constants.BROTLI_MODE_TEXT,
      [zlib.constants.BROTLI_PARAM_SIZE_HINT]: buf.length,
    },
  }));
}

/** Ejecuta fn sobre cada elemento con como mucho `limit` tareas a la vez; conserva el orden del resultado. */
export async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const lane = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, lane));
  return out;
}
