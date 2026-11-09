// Presupuestos de tamaño: límites por archivo de salida (por patrón) o para el total.
//   "budgets": { "js/**/*.js": "50 KB", "css/app.css": "20 KB gzip", "total": "1 MB brotli" }
// Si algo se pasa, la compilación falla antes de tocar outDir (como la verificación).
import picomatch from 'picomatch';
import { formatBytes } from './util.js';
import { L } from './i18n.js';

const UNITS = { b: 1, kb: 1024, mb: 1024 * 1024 };
const SIZE = /^\s*(\d+(?:\.\d+)?)\s*(b|kb|mb)?\s*(gzip|brotli)?\s*$/i;

/** "50 KB gzip" → { bytes: 51200, measure: 'gzip' }; un número se toma en bytes. Devuelve null si no es válido. */
export function parseBudget(value) {
  if (typeof value === 'number' && value > 0) return { bytes: Math.floor(value), measure: 'size' };
  const m = typeof value === 'string' ? SIZE.exec(value) : null;
  if (!m) return null;
  return { bytes: Math.round(Number(m[1]) * UNITS[(m[2] ?? 'b').toLowerCase()]), measure: (m[3] ?? 'size').toLowerCase() };
}

/** Errores de validación de la opción "budgets" (lista vacía si es correcta). */
export function validateBudgets(budgets) {
  if (budgets === false || budgets == null) return [];
  if (typeof budgets !== 'object' || Array.isArray(budgets))
    return [L('"budgets" debe ser un objeto { "patrón": "50 KB" }.', '"budgets" must be an object { "pattern": "50 KB" }.')];
  return Object.entries(budgets)
    .filter(([, v]) => !parseBudget(v))
    .map(([k, v]) =>
      L(
        `"budgets.${k}": ${JSON.stringify(v)} no es un tamaño válido (ej. "50 KB", "20 KB gzip", "1 MB brotli").`,
        `"budgets.${k}": ${JSON.stringify(v)} is not a valid size (e.g. "50 KB", "20 KB gzip", "1 MB brotli").`,
      ),
    );
}

const label = (m) => (m === 'size' ? '' : ` ${m}`);

/**
 * Comprueba los presupuestos contra las filas del informe de tamaños.
 * @returns {{violations: string[], unmatched: string[], checked: number}}
 */
export function checkBudgets(budgets, report) {
  const violations = [];
  const unmatched = [];
  let checked = 0;
  if (!budgets) return { violations, unmatched, checked };
  const rows = report.rows;
  const measureOf = (row, measure) => (measure === 'size' ? row.size : (row[measure] ?? row.size));
  for (const [pattern, value] of Object.entries(budgets)) {
    const b = parseBudget(value);
    if (pattern === 'total') {
      checked++;
      const total = rows.reduce((sum, r) => sum + measureOf(r, b.measure), 0);
      if (total > b.bytes)
        violations.push(
          L(
            `total${label(b.measure)}: ${formatBytes(total)} supera el presupuesto de ${formatBytes(b.bytes)}`,
            `total${label(b.measure)}: ${formatBytes(total)} exceeds the budget of ${formatBytes(b.bytes)}`,
          ),
        );
      continue;
    }
    const isMatch = picomatch(pattern.replace(/^\.\//, ''), { dot: true, nocase: true });
    const matched = rows.filter((r) => isMatch(r.file));
    if (!matched.length) unmatched.push(pattern);
    for (const r of matched) {
      checked++;
      const size = measureOf(r, b.measure);
      if (size > b.bytes)
        violations.push(
          L(
            `${r.file}${label(b.measure)}: ${formatBytes(size)} supera el presupuesto de ${formatBytes(b.bytes)} ("${pattern}")`,
            `${r.file}${label(b.measure)}: ${formatBytes(size)} exceeds the budget of ${formatBytes(b.bytes)} ("${pattern}")`,
          ),
        );
    }
  }
  return { violations, unmatched, checked };
}
