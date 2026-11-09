# vanilla-builder

[![CI](https://github.com/MarioACo/vanilla-builder/actions/workflows/ci.yml/badge.svg)](https://github.com/MarioACo/vanilla-builder/actions/workflows/ci.yml) [![npm](https://img.shields.io/npm/v/vanilla-builder)](https://www.npmjs.com/package/vanilla-builder) [![MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

**English** · [Español](README.es.md)

Bundle, minify and obfuscate **vanilla** web projects (HTML, CSS and JavaScript, no framework) **without losing anything**.
It follows the real dependencies of every page, verifies the output before publishing it and never deletes what it did not create.

- **Zero config**: point it at a folder with `.html` files and you are done.
- **Lossless**: every project file ends up with a known fate (processed, bundled, copied or deliberately skipped), and the output is verified before it replaces `dist/`.
- **Fast**: obfuscation and terser run in parallel threads, and a persistent cache makes rebuilds of unchanged files almost free (obfuscated 40-page test site: 11–18 s in 0.1.0 → 7 s first build, 1.8 s rebuild). See [Speed](#speed).
- **You decide what is a library**: third-party code is detected and never obfuscated; correct it from the HTML, the file itself or `builder deps`. See [Dependencies](#third-party-dependencies-and-obfuscation).
- **TypeScript included**: `<script src="app.ts">` just works; the output is `.js`.
- **Lightweight**: the base install is 8 packages (most of it is the esbuild binary). The obfuscator and terser are only installed if you use them.
- **Node 16 or newer** (tested on 16, 18, 20, 22 and 24, on Linux, Windows and macOS).

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
npx builder deps my-site                   # which JS files are libraries (not obfuscated) and which are yours
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
| `--workers <n\|auto>` | Threads for obfuscation/terser (`0` = no threads). |
| `--no-cache` | Ignore the cache from previous builds. |
| `--json` | JSON output for CI (exit code 1 if anything fails), including time per phase. |

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

Obfuscating jQuery, Bootstrap or an npm package protects nothing of yours, makes them slower and may violate their license. So when obfuscating, these are detected as dependencies and left untouched:

- Files in `vendor/`, `node_modules/`, `third-party/`…
- Well-known library names (`jquery-3.7.1.min.js`, `bootstrap.bundle.js`…) and compiled builds (`.min.js`, `.umd.js`).
- Files named like a package in your `package.json` `dependencies` (`js/chart.umd.js` when you depend on `chart.js`).
- UMD/AMD wrappers (the format libraries are published in), license headers with a version (`/*! Foo v1.2.0 */`) and already-minified code.
- npm packages imported by your module code are split into `assets/vendor/` (not obfuscated, with their shared state intact).

See what was detected and why:

```bash
npx builder deps my-site
```

Something wrong? There are three ways to fix it, pick the one that suits you:

```html
<!-- 1. In the HTML -->
<script src="js/my-lib.js" data-builder="dependency"></script>
<script src="js/app.min.js" data-builder="own"></script>
```

```js
/* 2. At the top of the file itself */
/* @builder-dependency */   // or: /* @builder-own */
```

```bash
# 3. From the terminal (edits builder.config.json for you, keeps the rest of it)
npx builder deps add "js/libs/**"     # these are libraries: don't obfuscate
npx builder deps own js/app.min.js    # this is my code: obfuscate it
npx builder deps reset js/app.min.js  # back to automatic detection
```

The config file has the last word over the marks, and the marks over the automatic detection:

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

## TypeScript

Point your HTML at `.ts` files (or at the `.js` name, as TypeScript itself recommends) and build:

```html
<script type="module" src="js/main.ts"></script>
```

- Each `.ts`/`.mts`/`.cts` is transpiled with esbuild using your `tsconfig.json` (types removed, syntax level untouched), then goes through the same pipeline as JavaScript: bundling, obfuscation, verification.
- The output is `.js` (`.mjs`/`.cjs`) and the HTML is rewritten to point to it. `import './x.ts'`, `import './x'`, `import './dir'` and `new URL('./worker.ts', import.meta.url)` keep working.
- `.d.ts` files and `*.test.ts` are not published.
- Builder does not type-check: run `tsc --noEmit` in your CI for that.

## Speed

Measured with `npm run bench` (a generated site with 40 pages, 240 modules, 120 classic scripts, 30 CSS files and 200 images; median of 3 runs on an i7-11700F, Node 24, Windows):

| Build | 0.1.0 | 0.2.0, first build | 0.2.0, rebuild (cache) |
| --- | ---: | ---: | ---: |
| Default | 3.7 s | 1.9 s | 1.4 s |
| `--obfuscate` | 11.5–17.9 s | 7.0 s | 1.8 s |
| `--hash --compress` | 2.6–3.8 s | 2.1 s | 1.1 s |
| `--minifier terser` | 5.6–6.0 s | 3.7 s | 1.6 s |

How:

- **Threads**: obfuscation, terser and the final syntax check run in worker threads (`workers: "auto"` ≈ physical cores, max 8). The main thread works too, and threads are only started when there is enough queued work to pay for their startup, so small projects are never slower.
- **Persistent cache**: results are stored by content in `node_modules/.cache/vanilla-builder` (or the system temp folder). Same input + same options + same tool versions = same output, byte for byte; the test suite checks it. Set `BUILDER_CACHE_DIR` to keep it between CI runs. `--no-cache` or `"cache": false` turns it off.
- **Parallel and in order**: independent files are processed at the same time but registered in the original order, so the output does not depend on timing.
- `--json` includes `perf.phases` (milliseconds per phase) to see where the time goes in your project.

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
  "cache": true,
  "workers": "auto",
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
npm run bench          # speed on a generated site, first build and with cache
npm run test:browser   # real equivalence in Chromium (finds Chrome/Edge or uses BUILDER_CHROMIUM)
BUILDER_NODE=/path/to/node16 npm run test:browser   # build with another Node and verify in the browser
```

## Known limits

- No obfuscator makes code impossible to read: it only makes it much more expensive.
- With `hash: true`, JS/CSS files are renamed; if your code requests them by string, the original path is also published and you get a warning.
- Collapsing HTML whitespace changes `textContent` (not what you see). To keep it byte for byte: `"html": { "collapseWhitespace": false }`.
- `import()` with computed paths and no fixed prefix makes that group of modules minify file by file in place (without bundling), so paths do not break.
- TypeScript: no type checking, no `.tsx`/JSX, and source maps point to the type-stripped JavaScript, not to the `.ts` lines.

## License

[MIT](LICENSE) © MarioACo
