// CSS: empaqueta @import, reescribe url() según la ubicación final y minifica con esbuild.
import path from 'node:path';
import * as esbuild from 'esbuild';
import { relFrom, toPosix } from './util.js';

/**
 * image-set("a.png" 1x) no lo reescribe esbuild al mover el CSS de carpeta.
 * Se convierte a la forma equivalente image-set(url("a.png") 1x), que sí reescribe.
 */
export function imageSetStringsToUrl(css) {
  const re = /(?:-webkit-)?image-set\(/gi;
  let out = '';
  let last = 0;
  let m;
  while ((m = re.exec(css))) {
    let i = m.index + m[0].length;
    let depth = 1;
    let chunk = '';
    let segStart = i;
    const flush = (end) => {
      chunk += css.slice(segStart, end);
    };
    while (i < css.length && depth > 0) {
      const c = css[i];
      if (c === '"' || c === "'") {
        let j = i + 1;
        while (j < css.length && css[j] !== c) j += css[j] === '\\' ? 2 : 1;
        if (depth === 1) {
          flush(i);
          chunk += `url(${css.slice(i, j + 1)})`;
          segStart = j + 1;
        }
        i = j + 1;
        continue;
      }
      if (c === '(') depth++;
      else if (c === ')') depth--;
      i++;
    }
    flush(i);
    out += css.slice(last, m.index + m[0].length) + chunk;
    last = i;
    re.lastIndex = i;
  }
  return last === 0 ? css : out + css.slice(last);
}

const EXTERNAL = /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i;

function cssPlugin(ctx, { outRel, consumed, label }) {
  return {
    name: 'vanilla-builder-css',
    setup(b) {
      b.onResolve({ filter: /.*/ }, (args) => {
        if (args.kind === 'entry-point') return undefined;
        const spec = args.path;
        if (EXTERNAL.test(spec) || /\{\{|\$\{/.test(spec)) return { path: spec, external: true };
        const isStdin = !args.importer || args.importer === '<stdin>';
        const fromRel = isStdin ? label : (relFrom(ctx.root, args.importer) ?? label);
        const baseDir = args.resolveDir ? (relFrom(ctx.root, args.resolveDir) ?? '') : path.posix.dirname(fromRel);
        const r = ctx.resolve(spec, baseDir);
        if (r.status !== 'ok') {
          ctx.reportBroken(fromRel, spec, r);
          return { path: spec, external: true };
        }
        if (args.kind === 'import-rule') return { path: ctx.abs(r.rel) };
        // url(): el archivo se copia a su ruta final y la URL se recalcula desde el CSS de salida.
        ctx.registerAsset(r.rel, fromRel);
        const target = ctx.assetOut(r.rel);
        let url = path.posix.relative(path.posix.dirname(outRel), target);
        if (!url) url = path.posix.basename(target);
        url = url
          .split('/')
          .map((s) => (s === '..' ? s : encodeURIComponent(s)))
          .join('/');
        return { path: url + r.info.suffix, external: true };
      });
      b.onLoad({ filter: /\.css$/i }, (args) => {
        const rel = relFrom(ctx.root, args.path);
        if (rel == null) return undefined;
        consumed.add(rel);
        const { text } = ctx.readText(rel, { kind: 'css' });
        return { contents: imageSetStringsToUrl(text), loader: 'css' };
      });
    },
  };
}

/**
 * Compila una hoja de estilos.
 * @param {object} ctx contexto del builder
 * @param {{entry?: string, inline?: {code: string, baseDir: string, label: string}, outRel: string}} job
 */
export async function buildCss(ctx, job) {
  const cfg = ctx.cfg;
  const consumed = new Set();
  const common = {
    bundle: cfg.css.bundle,
    write: false,
    minify: cfg.css.minify,
    target: cfg.css.target,
    logLevel: 'silent',
    absWorkingDir: ctx.root,
    outfile: path.join(ctx.root, '__vb_out__', job.outRel),
    plugins: [cssPlugin(ctx, { outRel: job.outRel, consumed, label: job.entry ?? job.inline?.label })],
    legalComments: cfg.css.minify ? cfg.js.legalComments : 'inline',
    charset: 'ascii',
    sourcemap: job.inline
      ? false
      : cfg.sourcemap === 'hidden'
        ? 'external'
        : cfg.sourcemap === 'inline'
          ? 'inline'
          : cfg.sourcemap
            ? 'linked'
            : false,
  };
  let result;
  try {
    result = job.inline
      ? await esbuild.build({
          ...common,
          stdin: {
            contents: imageSetStringsToUrl(job.inline.code),
            resolveDir: ctx.abs(job.inline.baseDir),
            loader: 'css',
            sourcefile: job.inline.label,
          },
        })
      : await esbuild.build({ ...common, entryPoints: [ctx.abs(job.entry)] });
  } catch (err) {
    return { error: esbuildErrorText(err, ctx.root) };
  }
  for (const w of result.warnings) ctx.warn(`CSS: ${formatMessage(w, ctx.root)}`, job.entry ?? job.inline?.label);
  let code = '';
  let map = null;
  for (const f of result.outputFiles) {
    if (f.path.endsWith('.map')) map = f.text;
    else code = f.text;
  }
  if (job.inline) code = code.replace(/\n$/, '');
  return { code, map, inputs: [...consumed] };
}

/** Minifica el contenido de un atributo style="" sin tocar sus URLs. */
export async function minifyStyleAttr(value, target) {
  if (!value.trim()) return value;
  try {
    const r = await esbuild.transform(`*{${value}}`, { loader: 'css', minify: true, target, charset: 'ascii', logLevel: 'silent' });
    const m = /^\*\{([\s\S]*)\}\s*$/.exec(r.code);
    if (!m || r.warnings.length) return value;
    return m[1];
  } catch {
    return value;
  }
}

export function formatMessage(m, root) {
  const loc = m.location ? `${toPosix(path.relative(root, path.resolve(root, m.location.file)))}:${m.location.line}:${m.location.column + 1} ` : '';
  return `${loc}${m.text}`;
}

export function esbuildErrorText(err, root) {
  if (err?.errors?.length) return err.errors.map((e) => formatMessage(e, root)).join('\n');
  return err?.message ?? String(err);
}
