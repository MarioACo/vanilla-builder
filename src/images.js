// Optimización de imágenes con sharp (dependencia opcional). Mismo formato y mismo nombre: no cambia ninguna referencia.
// - PNG: recompresión sin pérdida, comprobada píxel a píxel.
// - JPEG y WebP: se recodifican con la calidad indicada (con pérdida, visualmente equivalente).
// Se conservan los metadatos (orientación EXIF, perfil de color). Si el resultado no es más pequeño, se deja el original.
import { importOptional } from './optional.js';
import { L } from './i18n.js';

export const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp']);

let sharpMod = null;

export async function ensureSharp(root) {
  if (!sharpMod) {
    const mod = await importOptional('sharp', root, L('para optimizar imágenes (--images)', 'to optimize images (--images)'));
    sharpMod = mod.default ?? mod;
  }
  return sharpMod;
}

/** Opciones normalizadas de "images": false, true o { quality }. */
export function imageOptions(setting) {
  if (!setting) return null;
  const quality = typeof setting === 'object' && Number.isInteger(setting.quality) ? setting.quality : 80;
  return { quality };
}

async function samePixels(sharp, a, b) {
  const [ra, rb] = await Promise.all([
    sharp(a).ensureAlpha().raw().toBuffer({ resolveWithObject: true }),
    sharp(b).ensureAlpha().raw().toBuffer({ resolveWithObject: true }),
  ]);
  return ra.info.width === rb.info.width && ra.info.height === rb.info.height && ra.data.equals(rb.data);
}

/**
 * @returns {Promise<{data: Buffer} | {skip: string}>} la imagen optimizada, o el motivo para dejar la original.
 */
export async function optimizeImage(sharp, buf, ext, { quality }) {
  let meta;
  try {
    meta = await sharp(buf).metadata();
  } catch (err) {
    return { skip: L(`no se pudo leer la imagen (${err.message})`, `could not read the image (${err.message})`) };
  }
  if ((meta.pages ?? 1) > 1) return { skip: L('imagen animada', 'animated image') };
  const base = () => sharp(buf).keepMetadata();
  let out;
  try {
    if (ext === '.png') out = await base().png({ compressionLevel: 9, effort: 10, palette: false, adaptiveFiltering: true }).toBuffer();
    else if (ext === '.webp') out = await base().webp({ quality, effort: 6 }).toBuffer();
    else out = await base().jpeg({ quality, mozjpeg: true }).toBuffer();
  } catch (err) {
    return { skip: L(`sharp falló (${err.message})`, `sharp failed (${err.message})`) };
  }
  if (out.length >= buf.length) return { skip: L('ya estaba optimizada', 'already optimized') };
  const after = await sharp(out).metadata();
  if (after.width !== meta.width || after.height !== meta.height || after.format !== meta.format)
    return { skip: L('el resultado no conserva tamaño o formato', 'the result does not keep size or format') };
  if (ext === '.png' && !(await samePixels(sharp, buf, out))) return { skip: L('los píxeles no coinciden', 'pixels do not match') };
  return { data: out };
}
