// Ajuste mínimo de source maps v3 cuando se reemplaza texto en el código generado.
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_INDEX = Object.fromEntries([...B64].map((c, i) => [c, i]));

function decodeVlq(str) {
  const out = [];
  let value = 0;
  let shift = 0;
  for (const ch of str) {
    const digit = B64_INDEX[ch];
    value += (digit & 31) << shift;
    if (digit & 32) shift += 5;
    else {
      out.push(value & 1 ? -(value >>> 1) : value >>> 1);
      value = 0;
      shift = 0;
    }
  }
  return out;
}

function encodeVlq(n) {
  let v = n < 0 ? (-n << 1) | 1 : n << 1;
  let out = '';
  do {
    let digit = v & 31;
    v >>>= 5;
    if (v > 0) digit |= 32;
    out += B64[digit];
  } while (v > 0);
  return out;
}

/**
 * Reemplaza todas las apariciones de `search` por `replacement` y desplaza las columnas
 * del source map para que sigan apuntando al mismo código.
 */
export function replaceWithMap(code, map, search, replacement) {
  if (!code.includes(search)) return { code, map };
  const delta = replacement.length - search.length;
  // columnas (por línea) donde hubo reemplazos
  const edits = new Map();
  const lines = code.split('\n');
  const newLines = lines.map((line, i) => {
    if (!line.includes(search)) return line;
    const cols = [];
    let idx = line.indexOf(search);
    while (idx !== -1) {
      cols.push(idx);
      idx = line.indexOf(search, idx + search.length);
    }
    edits.set(i, cols);
    return line.split(search).join(replacement);
  });
  const newCode = newLines.join('\n');
  if (!map || delta === 0) return { code: newCode, map };
  const json = JSON.parse(map);
  const mapLines = json.mappings.split(';');
  for (const [lineNo, cols] of edits) {
    if (lineNo >= mapLines.length || !mapLines[lineNo]) continue;
    let prevIn = 0;
    let prevOut = 0;
    const segs = mapLines[lineNo].split(',').map((seg) => {
      const fields = decodeVlq(seg);
      const col = prevIn + fields[0];
      prevIn = col;
      const shift = cols.filter((c) => c < col).length * delta;
      const newCol = col + shift;
      fields[0] = newCol - prevOut;
      prevOut = newCol;
      return fields.map(encodeVlq).join('');
    });
    mapLines[lineNo] = segs.join(',');
  }
  json.mappings = mapLines.join(';');
  return { code: newCode, map: JSON.stringify(json) };
}
