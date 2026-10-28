// Vigila una carpeta y sus subcarpetas. fs.watch recursivo no existe en Linux antes de Node 20:
// en ese caso se vigila cada carpeta por separado y se añaden las nuevas al vuelo.
import fs from 'node:fs';
import path from 'node:path';

/**
 * @param {string} root
 * @param {(rel: string) => boolean} ignore recibe la ruta relativa (POSIX) y devuelve true para ignorarla
 * @param {(rel: string) => void} onChange
 * @returns {() => void} función para dejar de vigilar
 */
export function watchTree(root, ignore, onChange) {
  const emit = (abs) => {
    const rel = path.relative(root, abs).split(path.sep).join('/');
    if (rel && !rel.startsWith('..') && !ignore(rel)) onChange(rel);
  };
  try {
    const w = fs.watch(root, { recursive: true }, (_e, name) => name && emit(path.join(root, name.toString())));
    return () => w.close();
  } catch (err) {
    if (err.code !== 'ERR_FEATURE_UNAVAILABLE_ON_PLATFORM') throw err;
  }
  const watchers = new Map();
  const add = (dir) => {
    if (watchers.has(dir)) return;
    const rel = path.relative(root, dir).split(path.sep).join('/');
    if (rel && ignore(rel)) return;
    try {
      watchers.set(
        dir,
        fs.watch(dir, (_e, name) => {
          if (!name) return;
          const abs = path.join(dir, name.toString());
          try {
            if (fs.statSync(abs).isDirectory()) addTree(abs);
          } catch {
            /* borrado */
          }
          emit(abs);
        }),
      );
    } catch {
      /* sin permiso o borrada */
    }
  };
  const addTree = (dir) => {
    add(dir);
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) if (e.isDirectory()) addTree(path.join(dir, e.name));
  };
  addTree(root);
  return () => {
    for (const w of watchers.values()) w.close();
  };
}
