// Trabajo pesado (ofuscación y terser) en hilos paralelos, con caché persistente entre compilaciones.
// La salida no depende del orden ni del número de hilos: cada tarea es determinista (la semilla del
// ofuscador sale del contenido), así que reutilizar un resultado guardado da exactamente lo mismo.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { Worker } from 'node:worker_threads';
import { ensureObfuscator, obfuscateSafe } from './obfuscate.js';
import { importOptional } from './optional.js';
import { terserMinify } from './tersercore.js';
import { jsImports } from './jsimports.js';
import { L, getLang } from './i18n.js';

const WORKER_URL = new URL('./worker.js', import.meta.url);
const OWN_VERSION = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const CACHE_FORMAT = 1;
const CACHE_MAX_BYTES = 256 * 1024 * 1024;
const TASKS_PER_NEW_WORKER = 4;

/**
 * Hilos por defecto: aproximadamente los núcleos físicos (la mitad de los lógicos), máximo 8.
 * Medido: más allá de eso el ofuscador apenas escala (memoria y recolector de basura).
 */
export function autoWorkers() {
  const cpus = typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length;
  return Math.max(1, Math.min(8, Math.floor(cpus / 2)));
}

/** Versión instalada de un paquete (para invalidar la caché al actualizarlo). */
function packageVersion(name, root) {
  for (const base of [new URL('../package.json', import.meta.url), path.join(root ?? process.cwd(), 'package.json')]) {
    try {
      let dir = path.dirname(createRequire(base).resolve(name));
      for (let i = 0; i < 6; i++, dir = path.dirname(dir)) {
        const file = path.join(dir, 'package.json');
        if (fs.existsSync(file)) {
          const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
          if (pkg.name === name) return pkg.version;
        }
      }
    } catch {
      // no instalado aquí: se prueba la siguiente ubicación
    }
  }
  return 'unknown';
}

/** Carpeta de caché: node_modules/.cache/vanilla-builder más cercano, o el temporal del sistema. */
export function defaultCacheDir(root) {
  // BUILDER_CACHE_DIR: para CI (guardarla entre ejecuciones) o para aislar pruebas.
  if (process.env.BUILDER_CACHE_DIR) return path.resolve(process.env.BUILDER_CACHE_DIR);
  for (let dir = root, i = 0; i < 20; i++) {
    const nm = path.join(dir, 'node_modules');
    if (fs.existsSync(nm)) return path.join(nm, '.cache', 'vanilla-builder');
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  const id = crypto.createHash('sha256').update(root).digest('hex').slice(0, 12);
  return path.join(os.tmpdir(), 'vanilla-builder-cache', id);
}

const plain = (v) => (v instanceof Map ? [...v.entries()] : v);

/**
 * @param {{root: string, workers?: number, cacheDir?: string|null}} opts
 */
export function createHeavy({ root, workers = autoWorkers(), cacheDir = null }) {
  const stats = { tasks: 0, cacheHits: 0, threads: 0 };
  const versions = new Map();
  const idle = [];
  const all = [];
  const queue = [];
  const pending = new Map();
  let nextId = 1;
  let broken = false;
  let inProcessTerser = null;

  const versionOf = (name) => {
    if (!versions.has(name)) versions.set(name, packageVersion(name, root));
    return versions.get(name);
  };

  function cacheKey(kind, payload) {
    const engine = kind === 'obfuscate' ? 'javascript-obfuscator' : kind === 'terser' ? 'terser' : 'acorn';
    // El idioma entra en la clave: los motivos de rechazo ("no se ofuscó: …") se guardan ya traducidos.
    const meta = JSON.stringify([CACHE_FORMAT, OWN_VERSION, kind, versionOf(engine), getLang(), payload.opts, plain(payload.opts.globals)]);
    return crypto.createHash('sha256').update(meta).update('\0').update(payload.code).digest('hex');
  }

  // Valores pequeños (importaciones, tamaños, resultados cortos): un único índice JSON en vez de miles
  // de archivos diminutos, que en Windows (antivirus, indexado) cuestan más que calcularlos.
  const SMALL_FILE = cacheDir ? path.join(cacheDir, 'small-v1.json') : null;
  const SMALL_LIMIT = 2048;
  const SMALL_MAX_ENTRIES = 100000;
  let small = null;
  let smallDirty = false;
  function smallStore() {
    if (!small) {
      small = new Map();
      try {
        for (const [k, v] of JSON.parse(fs.readFileSync(SMALL_FILE, 'utf8'))) small.set(k, v);
      } catch {
        // índice ausente o dañado: se empieza vacío
      }
    }
    return small;
  }
  function saveSmall() {
    if (!smallDirty || !SMALL_FILE) return;
    const entries = [...small.entries()].slice(-SMALL_MAX_ENTRIES);
    const tmp = `${SMALL_FILE}.${process.pid}.tmp`;
    try {
      fs.mkdirSync(cacheDir, { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify(entries));
      fs.renameSync(tmp, SMALL_FILE);
    } catch {
      try {
        fs.rmSync(tmp, { force: true });
      } catch {
        // la caché es opcional
      }
    }
  }

  function readCache(key) {
    if (!cacheDir) return undefined;
    const s = smallStore();
    if (s.has(key)) {
      // Al final del Map = usado recientemente (se conservan los últimos al recortar).
      const v = s.get(key);
      s.delete(key);
      s.set(key, v);
      smallDirty = true;
      return v;
    }
    const file = path.join(cacheDir, key.slice(0, 2), `${key}.json`);
    try {
      const value = JSON.parse(fs.readFileSync(file, 'utf8'));
      const now = new Date();
      fs.utimes(file, now, now, () => {});
      return value;
    } catch {
      return undefined;
    }
  }

  function writeCache(key, value) {
    if (!cacheDir) return;
    const json = JSON.stringify(value);
    if (json.length <= SMALL_LIMIT) {
      smallStore().set(key, value);
      smallDirty = true;
      return;
    }
    const dir = path.join(cacheDir, key.slice(0, 2));
    const file = path.join(dir, `${key}.json`);
    const tmp = `${file}.${process.pid}.${nextId}.tmp`;
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(tmp, json);
      fs.renameSync(tmp, file);
    } catch {
      try {
        fs.rmSync(tmp, { force: true });
      } catch {
        // la caché es opcional: un fallo al escribirla no afecta a la compilación
      }
    }
  }

  async function runInProcess(kind, payload) {
    if (kind === 'imports') return jsImports(payload.code, payload.opts.isModule);
    if (kind === 'obfuscate') {
      await ensureObfuscator(root);
      return obfuscateSafe(payload.code, payload.opts);
    }
    inProcessTerser ??= await importOptional('terser', root, L('para la compresión máxima', 'for maximum compression'));
    return terserMinify(inProcessTerser, payload.code, payload.opts);
  }

  function spawn() {
    const w = new Worker(WORKER_URL, { workerData: { root, lang: getLang() } });
    w.on('message', ({ id, result, error }) => {
      const p = pending.get(id);
      pending.delete(id);
      w.busy = null;
      idle.push(w);
      pump();
      if (!p) return;
      if (error) p.reject(new Error(error));
      else p.resolve(result);
    });
    w.on('error', (err) => {
      // Si un hilo muere, sus tareas (y las siguientes) se hacen en el hilo principal.
      broken = true;
      const id = w.busy;
      if (id != null && pending.has(id)) {
        const p = pending.get(id);
        pending.delete(id);
        runInProcess(p.kind, p.payload).then(p.resolve, p.reject);
      }
      void err;
    });
    all.push(w);
    stats.threads = all.length;
    return w;
  }

  // El hilo principal toma la primera tarea libre (no hay que esperar a que arranque nada) y solo se
  // crean hilos cuando hay más trabajo en cola: uno por tarea pendiente, hasta el máximo. Así un proyecto
  // pequeño nunca paga el arranque de los hilos (cargar el ofuscador cuesta ~0,5 s por hilo).
  let mainBusy = false;
  function runOnMain(t) {
    mainBusy = true;
    setImmediate(async () => {
      try {
        t.resolve(await runInProcess(t.kind, t.payload));
      } catch (err) {
        t.reject(err);
      } finally {
        mainBusy = false;
        pump();
      }
    });
  }

  function pump() {
    while (queue.length) {
      if (broken) {
        const t = queue.shift();
        runInProcess(t.kind, t.payload).then(t.resolve, t.reject);
        continue;
      }
      let w = idle.pop();
      if (!w) {
        if (!mainBusy) {
          runOnMain(queue.shift());
          continue;
        }
        // Un hilo nuevo solo compensa con trabajo de sobra para él: arrancarlo cuesta lo que varias tareas.
        if (all.length >= workers || queue.length < TASKS_PER_NEW_WORKER * (all.length + 1)) return;
        w = spawn();
      }
      const t = queue.shift();
      const id = nextId++;
      w.busy = id;
      pending.set(id, t);
      w.postMessage({ id, kind: t.kind, payload: t.payload });
    }
  }

  async function run(kind, payload) {
    const counted = kind === 'obfuscate' || kind === 'terser';
    if (counted) stats.tasks++;
    const key = cacheDir ? cacheKey(kind, payload) : null;
    if (key) {
      const hit = readCache(key);
      if (hit !== undefined) {
        if (counted) stats.cacheHits++;
        return hit;
      }
    }
    const result =
      workers > 0
        ? await new Promise((resolve, reject) => {
            queue.push({ kind, payload, resolve, reject });
            pump();
          })
        : await runInProcess(kind, payload);
    if (key) writeCache(key, result);
    return result;
  }

  return {
    stats,
    /** Ofusca y verifica (ver obfuscateSafe). */
    obfuscate: (code, opts) => run('obfuscate', { code, opts }),
    /** Importaciones de un JS generado, o {error} si no es válido (verificación final). */
    imports: (code, isModule) => run('imports', { code, opts: { isModule } }),
    /** Valor costoso guardado en la caché por clave (p. ej. tamaños comprimidos de un contenido). */
    async memo(kind, keyData, compute) {
      const key = cacheDir
        ? crypto
            .createHash('sha256')
            .update(JSON.stringify([CACHE_FORMAT, OWN_VERSION, getLang(), kind]))
            .update('\0')
            .update(keyData)
            .digest('hex')
        : null;
      if (key) {
        const hit = readCache(key);
        if (hit !== undefined) return hit;
      }
      const value = await compute();
      if (key) writeCache(key, value);
      return value;
    },
    /** Pasada de terser verificada (ver terserMinify). */
    terser: (code, opts) => run('terser', { code, opts }),
    async close() {
      await Promise.all(all.map((w) => w.terminate()));
      all.length = 0;
      idle.length = 0;
      if (cacheDir) {
        saveSmall();
        pruneCache(cacheDir);
      }
    },
  };
}

/** Mantiene la caché por debajo del límite borrando lo usado hace más tiempo. */
function pruneCache(dir) {
  let entries = [];
  try {
    for (const sub of fs.readdirSync(dir)) {
      if (!/^[0-9a-f]{2}$/.test(sub)) continue;
      const d = path.join(dir, sub);
      for (const f of fs.readdirSync(d)) {
        const file = path.join(d, f);
        const st = fs.statSync(file);
        entries.push({ file, size: st.size, time: st.mtimeMs });
      }
    }
  } catch {
    return;
  }
  let total = entries.reduce((a, e) => a + e.size, 0);
  if (total <= CACHE_MAX_BYTES) return;
  entries = entries.sort((a, b) => a.time - b.time);
  for (const e of entries) {
    if (total <= CACHE_MAX_BYTES * 0.8) break;
    try {
      fs.rmSync(e.file, { force: true });
      total -= e.size;
    } catch {
      // otro proceso pudo borrarlo
    }
  }
}
