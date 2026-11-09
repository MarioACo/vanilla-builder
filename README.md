# vanilla-builder

[![CI](https://github.com/MarioACo/vanilla-builder/actions/workflows/ci.yml/badge.svg)](https://github.com/MarioACo/vanilla-builder/actions/workflows/ci.yml) [![npm](https://img.shields.io/npm/v/vanilla-builder)](https://www.npmjs.com/package/vanilla-builder) [![MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

**English** · [Español](README.es.md)

Bundle, minify and obfuscate **vanilla** web projects (HTML, CSS and JavaScript, no framework) **without losing anything**.
It follows the real dependencies of every page, verifies the output before publishing it and never deletes what it did not create.

- **Zero config**: point it at a folder with `.html` files and you are done.
- **Lossless**: every project file ends up with a known fate (processed, bundled, copied or deliberately skipped), and the output is verified before it replaces `dist/`.
- **Lightweight**: 57 KB of its own code; the base install is 8 packages (most of it is the esbuild binary). The obfuscator and terser are only installed if you use them.
- **Node 16 or newer** (tested on 16, 18, 20, 22 and 24).

## Install

```bash
npm install --save-dev vanilla-builder
npm install --save-dev javascript-obfuscator    # only if you obfuscate
npm install --save-dev terser                   # only if you want maximum compression
```

> On Node 16 and 17 npm prints an `EBADENGINE` warning because esbuild declares Node 18+. It is only a warning:
> the whole test suite (browser tests included) passes when building with Node 16.

## Usage

```bash
npx builder build my-site                  # builds into my-site/dist
npx builder build my-site --obfuscate      # also obfuscates your JavaScript (medium level)
npx builder analyze my-site                # shows what will happen to each file, writes nothing
npx builder init my-site                   # creates builder.config.json from what it detected
npx builder dev my-site                    # builds, watches and serves dist/ with live reload
npx builder serve my-site                  # serves dist/ to try it out
```

Common `build` options (all of them have a config equivalent):

| Option | What it does |
| --- | --- |
| `--obfuscate [low\|medium\|high\|max]` | Obfuscates your JS. Third-party libraries are detected and left untouched. |
| `--dep <pattern>` / `--not-dep <pattern>` | Manually mark a dependency / correct a detection. |
| `--obfuscate-deps` | Obfuscate dependencies too. |
| `--minifier terser` | Second compression pass with terser (even smaller JS). |
| `--compress [gzip\|brotli]` | Also emits `.gz` and `.br` files for servers that serve precompressed assets. |
| `--hash` | Hashed JS/CSS file names for long-term caching. |
| `--sourcemap [linked\|hidden\|inline]` | Source maps. |
| `--target es2018` | Transpile to a specific level (default: whatever your own code already uses). |
| `--drop-console` | Removes `console.*` and `debugger`. |
| `--entry`, `--include`, `--ignore` | Explicit entries, forced files and exclusions (repeatable). |
| `--json` | JSON output for CI (exit code 1 if anything fails). |

Run `npx builder help` for the full list.

## What it detects on its own

Starting from each `.html` file, it follows:

- Classic and `type="module"` `<script src>`, inline scripts and **import maps**.
- `<link rel="stylesheet">`, CSS `@import` and `url()` (including `image-set()`), `<style>` and `style` attributes.
- Images, `srcset`, video, audio, icons, manifest, `og:image`, `<iframe>`, `<object>`, SVG `<use>`…
- Links to other pages, dynamic `import()`, `new URL('./x', import.meta.url)`.
- Workers, service workers and `importScripts()`.
- Paths written as strings in JS (for example a service worker precache list): those files are also published at their original path.

What cannot be followed (a `fetch(variable)`, a server template…) **is not lost**: the folder structure is preserved and everything unreferenced is still published (`unreferenced: "process"`).

## Guarantees

| Typical bundler risk | How vanilla-builder avoids it |
| --- | --- |
| Concatenating classic scripts breaks globals | Only merges consecutive scripts with the same `defer`/strict mode, no `document.currentScript`, no `let/const` redeclarations, and a safe `;` separator. |
| Minification creates new globals or renames yours | Compares globals before and after; if they differ it falls back to a more conservative minification or keeps the original. |
| The obfuscator breaks exports or `with { type }` attributes | Checks exports, imports and attributes after obfuscating; if they do not match, that file is not obfuscated. |
| esbuild silently drops `with { type: 'css' }` | Import attributes are forcibly preserved. |
| HTML minification changes the text | Own minifier on top of parse5 plus a structural check (elements, attributes and text). `<pre>`, `<textarea>` and templates stay intact; if the CSS uses `white-space: pre`, whitespace is not collapsed. |
| Stale `integrity` (SRI) blocks scripts | Recomputed whenever the content changes. |
| Legacy encodings or BOM | Bytes are preserved (HTML) or JS/CSS is emitted with ASCII escapes. |
| Reformatted JSON loses precision | Only whitespace outside strings is removed: `2.0` and huge numbers stay the same. |
| Wiping the wrong `dist/` | Never empties a folder it did not create (marked with `.builder-manifest.json`), nor the project folder, nor the root. |
| Half-finished build | Writes into a temp folder, verifies it, and only then replaces `dist/`. |
| Publishing secrets | `.env*`, `.pem/.key` keys, `node_modules`, `package.json` and tool configs are excluded by default. |

The test suite opens every example site **original and built in Chromium** and requires identical results, with no errors and no 404s, across 5 variants (default, high obfuscation + hash, max obfuscation, terser + precompression, unminified).

## Third-party dependencies and obfuscation

Obfuscating jQuery, Bootstrap or an npm package protects nothing of yours, makes them slower and may violate their license. So when obfuscating:

- Files in `vendor/`, `node_modules/`, `third-party/`…, well-known library names (`jquery-3.7.1.min.js`, `bootstrap.bundle.js`…), `.min.js`/`.umd.js` files, already-minified code and license headers with a version (`/*! Foo v1.2.0 */`) are detected as dependencies.
- npm packages imported by your module code are split into `assets/vendor/` (not obfuscated, with their shared state intact).
- `builder analyze` lists what it detected and why.

To correct it by hand:

```json
{
  "obfuscate": "high",
  "dependencies": {
    "include": ["js/my-library.js"],
    "exclude": ["js/app.min.js"],
    "obfuscate": false
  }
}
```

`include` marks dependencies that were not detected; `exclude` says a file is yours and should be obfuscated; `obfuscate: true` obfuscates everything.

Levels: `low` (almost free), `medium` (recommended), `high` and `max` (also defends against being reformatted or tampered with; heavier and slower). Options that change behavior (`debugProtection`, `disableConsoleOutput`, `renameGlobals`) are never turned on automatically; pass them with an object: `"obfuscate": { "preset": "high", "debugProtection": true }`. Your license comments (`/*! … */`, `@license`) are kept.

## Configuration (`builder.config.json`)

```json
{
  "outDir": "dist",
  "entries": "auto",
  "include": [],
  "ignore": [],
  "unreferenced": "process",
  "obfuscate": false,
  "dependencies": { "detect": true, "obfuscate": false, "include": [], "exclude": [] },
  "hash": false,
  "sourcemap": false,
  "compress": false,
  "base": "/",
  "sri": "auto",
  "html": { "minify": true, "removeComments": true, "collapseWhitespace": "auto" },
  "css": { "minify": true, "bundle": true, "target": "esnext" },
  "js": { "minify": true, "bundle": true, "target": "auto", "minifier": "esbuild", "mergeClassic": "auto", "drop": [], "legalComments": "eof", "chunkDir": "assets" }
}
```

- `entries`: `"auto"` takes every complete HTML file; it also accepts a list of `.html`, `.js` or `.css` files.
- `unreferenced`: what to do with files nothing references: `process` (minify and publish), `copy` or `skip`.
- `js.target: "auto"` uses the syntax level of your own code: it neither transpiles nor introduces newer syntax than you already use.
- `builder.config.mjs` is also accepted (export an object or a function). Misspelled options raise an error with a suggestion.

## API

```js
import { build, analyze } from 'vanilla-builder';

const result = await build({ dir: 'my-site', overrides: { obfuscate: 'high' } });
console.log(result.report.totals, result.warnings);
```

## Development

```bash
npm test               # unit + integration (Node 18+; on Node 16: npm run test:node16)
npm run test:browser   # real equivalence in Chromium (finds Chrome/Edge or uses BUILDER_CHROMIUM)
BUILDER_NODE=/path/to/node16 npm run test:browser   # build with another Node and verify in the browser
```

## Known limits

- No obfuscator makes code impossible to read: it only makes it much more expensive.
- With `hash: true`, JS/CSS files are renamed; if your code requests them by string, the original path is also published and you get a warning.
- Collapsing HTML whitespace changes `textContent` (not what you see). To keep it byte for byte: `"html": { "collapseWhitespace": false }`.
- `import()` with computed paths and no fixed prefix makes that group of modules minify file by file in place (without bundling), so paths do not break.

## License

[MIT](LICENSE) © MarioACo
