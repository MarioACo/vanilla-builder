# vanilla-builder

[![CI](https://github.com/MarioACo/vanilla-builder/actions/workflows/ci.yml/badge.svg)](https://github.com/MarioACo/vanilla-builder/actions/workflows/ci.yml) [![npm](https://img.shields.io/npm/v/vanilla-builder)](https://www.npmjs.com/package/vanilla-builder) [![Node](https://img.shields.io/badge/node-%3E%3D16-brightgreen)](#requirements) [![MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

**English** · [Español](README.es.md)

**A production build for plain HTML, CSS and JavaScript sites — no framework, no config, nothing lost.**

Point it at a folder with `.html` files. It finds every script, stylesheet, image and page they use, bundles and minifies them, can obfuscate your JavaScript (while leaving third-party libraries alone), checks the result, and only then writes `dist/`.

```text
my-site/                          my-site/dist/
├── index.html                    ├── index.html          ← minified, paths updated
├── about.html                    ├── about.html
├── css/main.css  (+ @imports)    ├── css/main.css        ← one file, minified
├── js/app.js     (+ imports)  →  ├── js/app.js           ← bundled, minified, optionally obfuscated
├── js/vendor/jquery.min.js       ├── js/vendor/jquery.min.js   ← detected as a library, never obfuscated
├── img/…                         ├── img/…               ← copied as is
└── .env                          └── (not published: secrets are excluded)
```

## Contents

- [Why vanilla-builder](#why-vanilla-builder)
- [How it compares](#how-it-compares)
- [Requirements](#requirements)
- [Quick start](#quick-start)
- [Common tasks](#common-tasks)
- [How it works](#how-it-works)
- [Third-party libraries and obfuscation](#third-party-libraries-and-obfuscation)
- [TypeScript](#typescript)
- [Configuration](#configuration)
- [Plugins](#plugins)
- [GitHub Action](#github-action)
- [Command-line reference](#command-line-reference)
- [Safety guarantees](#safety-guarantees)
- [Performance](#performance)
- [JavaScript API](#javascript-api)
- [Troubleshooting](#troubleshooting)
- [Known limitations](#known-limitations)
- [Contributing](#contributing)

## Why vanilla-builder

Tools like Vite or webpack assume an app with an entry point and a module graph. Many real sites are not like that: several HTML pages, classic `<script>` tags that share globals, a copied `jquery.min.js`, a service worker with a list of files. vanilla-builder is made for those sites.

- **Zero configuration.** Every complete `.html` file is an entry point. Nothing to declare.
- **Nothing is lost.** Every file in the project ends with a known fate (processed, bundled, copied or deliberately excluded) and you can see which one. Files it cannot trace are still published.
- **Verified output.** The build is written to a temporary folder, checked (every reference resolves, every JS file parses, every source file is accounted for) and only then swapped into `dist/`. A failed build never leaves you with a broken `dist/`.
- **Safe for classic scripts.** It only merges or minifies scripts when it can prove the global variables stay the same.
- **Obfuscation that respects libraries.** Your code is protected; jQuery, Bootstrap and npm packages are detected and left as they are. You can correct the detection in one line.
- **TypeScript without setup.** `<script src="app.ts">` works; the output is `.js`.
- **Fast.** Parallel threads and a persistent cache: rebuilding an obfuscated 40-page site takes under 2 seconds ([numbers](#performance)).
- **Production extras built in.** Target browsers from `browserslist`, optional image optimization, size budgets that fail CI, plugins, and a GitHub Action with a size report on every pull request.

## How it compares

The same test sites built with each tool's default settings for a multi-page site, then opened in Chromium next to the original ([full results and method](bench/compare/RESULTS.md), reproducible with `cd bench/compare && npm install && node run.mjs`):

| Test site | vanilla-builder | Parcel 2.16 | Vite 8.3 |
| --- | --- | --- | --- |
| Classic scripts sharing globals, a worker, a copied library | ✅ identical | ❌ build fails (worker created from a string) | ❌ 404s: classic scripts are not published |
| ES modules, import map, service worker, CSS module script | ✅ identical | ❌ build fails (service worker from a string) | ❌ build fails (CSS import attribute) |
| npm packages from modules and classic scripts | ✅ identical | ✅ identical | ❌ 404s: classic scripts are not published |

Build time and size on a generated 40-page site (cold, no cache), counting only outputs whose pages work:

| | Time | Output (gzip) |
| --- | ---: | ---: |
| vanilla-builder, publishing only referenced files (`"unreferenced": "skip"`) | **1.2 s** | **64.8 KB** |
| vanilla-builder, default (also publishes unreferenced files) | 1.2 s | 156.6 KB |
| Parcel | 2.1–2.9 s | 102.6 KB |
| Vite | 0.3 s | — (output broken: 12 problems on 3 sample pages, such as 404s for classic scripts) |

These tools aim at different things: Vite and Parcel shine for apps with an entry point and a module graph. vanilla-builder is for sites that are a folder of pages and must keep working exactly as before.

## Requirements

- **Node.js 16 or newer.** Tested on Node 16, 18, 20, 22 and 24, on Linux, Windows and macOS.
- Optional, only if you use them: [`javascript-obfuscator`](https://www.npmjs.com/package/javascript-obfuscator) for `--obfuscate`, [`terser`](https://www.npmjs.com/package/terser) for `--minifier terser`, [`browserslist`](https://www.npmjs.com/package/browserslist) for target browsers and [`sharp`](https://www.npmjs.com/package/sharp) (Node 20+) for `--images`.

On Node 16 and 17, npm prints an `EBADENGINE` warning because esbuild declares Node 18+. It is only a warning; the full test suite passes on Node 16.

## Quick start

**1. Install it in your project:**

```bash
npm install --save-dev vanilla-builder
```

**2. Build:**

```bash
npx builder build
```

The result is in `dist/`. The terminal shows a table with each output file and its size before, after, gzipped and brotli-compressed, then confirms the verification:

```text
✔ 3 html · 8 js · 1 css · 1 json · 4 svg · 1 text  (0.21 s)
✔ Verification: 18 files written, 17 references checked, 8 valid JS, 0 errors
✔ Coverage: 21/21 source files with a known destination
```

**3. Try the result in the browser:**

```bash
npx builder serve        # http://127.0.0.1:5173
```

Optionally, add scripts to your `package.json`:

```json
{
  "scripts": {
    "dev": "builder dev",
    "build": "builder build"
  }
}
```

> Commands accept a folder: `npx builder build my-site` builds `my-site/` into `my-site/dist/`. Without one, the current folder is used.
>
> Messages are in English, or in Spanish when your system is (`--lang es|en` or `BUILDER_LANG` to choose). `--json` field names are always English.

Prefer to start from something that works? See the runnable [examples](examples/): a classic multi-page site, a TypeScript app and an obfuscated app with size budgets.

## Common tasks

### Develop with live reload

```bash
npx builder dev                 # builds, watches for changes, serves dist/ and reloads the browser
npx builder dev --port 3000 --open
```

When only CSS changes, stylesheets are swapped in place without reloading the page, so you keep its state.

### Publish a static site (Netlify, GitHub Pages, S3, nginx…)

```bash
npx builder build --hash --compress
```

- `--hash` renames JS and CSS to `name-<hash>.js` so you can cache them forever; HTML references are updated.
- `--compress` also writes `.gz` and `.br` next to each file for servers that serve precompressed files (nginx `gzip_static`, `brotli_static`).

If the site is served from a subfolder (`https://example.com/shop/`), add `--base /shop/` so absolute paths (`/js/app.js`) resolve correctly.

### Protect your JavaScript

```bash
npm install --save-dev javascript-obfuscator
npx builder build --obfuscate            # medium level (recommended)
npx builder build --obfuscate high
```

Third-party libraries are detected and not obfuscated. Check what was detected with `npx builder deps` — see [Third-party libraries](#third-party-libraries-and-obfuscation).

### Make JavaScript as small as possible

```bash
npm install --save-dev terser
npx builder build --minifier terser --drop-console
```

### Support older browsers

Declare your browsers the standard way and Builder uses them for CSS and JavaScript: missing vendor prefixes are added (`-webkit-backdrop-filter`), nested CSS is flattened and newer JavaScript syntax is rewritten.

```json
// package.json
{ "browserslist": ["> 0.5%", "last 2 versions", "not dead"] }
```

```bash
npm install --save-dev browserslist
```

A `.browserslistrc` file works too, and so does `--browsers "<query>"`. Without browsers, your code keeps its own syntax level.

### Optimize images

```bash
npm install --save-dev sharp
npx builder build --images                 # PNG lossless, JPEG/WebP at quality 80
npx builder build --image-quality 70
```

PNG files are recompressed without loss and checked pixel by pixel. JPEG and WebP are re-encoded at the chosen quality (this is lossy, visually equivalent at the default), keeping EXIF orientation and color profiles. File names stay the same, and an image is only replaced when the result is smaller.

### Keep sizes under control

```json
{
  "budgets": {
    "js/**/*.js": "50 KB",
    "css/app.css": "20 KB gzip",
    "total": "1 MB brotli"
  }
}
```

If any file (or the total) goes over its budget, the build fails before touching `dist/` and lists what is over. In CI you can also pass `--budget "total=1MB gzip"`.

### See what will happen before building

```bash
npx builder analyze
```

Lists every file with what will happen to it, the detected libraries and workers, broken references that already exist in your source, and excluded files. Nothing is written.

### Use it in CI

```bash
npx builder build --json > build-report.json
```

- Exit code `0` on success and non-zero if the build or the verification fails; in that case `dist/` is left untouched and the JSON has `"ok": false` with the error.
- The JSON includes outputs, sizes, warnings, detected dependencies and time per phase (`perf.phases`).
- To reuse the cache between runs, set `BUILDER_CACHE_DIR` to a folder your CI caches.
- On GitHub, the [GitHub Action](#github-action) does all of this and adds a size report to each run and pull request.

## How it works

1. **Discover.** Every complete HTML page is parsed. From it, Builder follows scripts (classic and modules, inline and import maps), stylesheets (`@import`, `url()`, `image-set()`), images and `srcset`, media, icons, manifests, `og:image`, iframes, links to other pages, dynamic `import()`, `new URL('./x', import.meta.url)`, workers, service workers, `importScripts()` and paths written as strings in your code (such as a precache list).
2. **Process.**
   - ES modules are bundled with [esbuild](https://esbuild.github.io/) (code splitting included). The syntax level of your own code is kept: nothing is transpiled unless you ask with `--target`.
   - Consecutive classic scripts are merged only when it is safe, then minified.
   - CSS is bundled and minified; HTML is minified with a conservative minifier that keeps `<pre>`, `<textarea>` and templates intact.
   - JSON loses only whitespace. Everything else (images, fonts, data) is copied.
3. **Protect (optional).** Your JavaScript is obfuscated; libraries are not.
4. **Verify.** In a temporary folder: every reference resolves, every JS file parses, sizes match, every source file has a destination.
5. **Publish.** The temporary folder replaces `dist/`.

Files nothing references are still minified and published at their original path (`unreferenced: "process"`), so a `fetch(variable)` or a server template that loads a file keeps working.

## Third-party libraries and obfuscation

Obfuscating jQuery, Bootstrap or an npm package protects nothing of yours, makes it slower and may break its license. When obfuscating, these are treated as libraries and left untouched:

| Signal | Example |
| --- | --- |
| Lives in a library folder | `vendor/`, `node_modules/`, `third-party/`, `external/`… |
| Well-known library name | `jquery-3.7.1.min.js`, `bootstrap.bundle.js`, `chart.umd.js` |
| Already compiled | `.min.js`, `.umd.js`, or already-minified code |
| Named like a package you depend on | `js/swiper.js` when `package.json` lists `swiper` in `dependencies` |
| Library wrapper | UMD/AMD (`typeof define === "function" && define.amd`) |
| License header with a version | `/*! Foo v1.2.0 */` |

npm packages imported by your modules (`import confetti from 'canvas-confetti'`) are bundled from `node_modules`. When obfuscating, they are split into separate files in `assets/vendor/`, left unobfuscated and shared between pages.

### Check and correct the detection

```bash
npx builder deps
```

```text
Third-party libraries (not obfuscated) (3)
  • js/vendor/jquery.min.js — in vendor/
  • js/chart.js — named like the "chart.js" package in your package.json
  • js/slider.js — UMD/AMD wrapper (published library format)

Your code (obfuscated with --obfuscate) (1)
  • js/app.js
```

Add `--json` for `{ "dependencies": [{ "rel", "reason" }], "own": [] }`.

If something is classified wrong, fix it in whichever place suits you:

#### In the HTML

```html
<script src="js/my-lib.js" data-builder="dependency"></script>   <!-- a library: don't obfuscate -->
<script src="js/app.min.js" data-builder="own"></script>         <!-- my code: obfuscate -->
```

#### At the top of the file

```js
/* @builder-dependency */      // or /* @builder-own */
```

#### From the terminal

Writes `builder.config.json` for you and keeps your other settings:

```bash
npx builder deps add "js/libs/**"       # these are libraries
npx builder deps own js/app.min.js      # this is my code
npx builder deps reset js/app.min.js    # back to automatic detection
```

#### In the configuration

```json
{
  "dependencies": {
    "include": ["js/my-library.js"],
    "exclude": ["js/app.min.js"]
  }
}
```

Priority: configuration › marks in the HTML or file › automatic detection. To obfuscate everything, libraries included, use `--obfuscate-deps` (`"dependencies": { "obfuscate": true }`).

### Obfuscation levels

| Level | Use it for |
| --- | --- |
| `low` | Renaming and string hiding. Almost no runtime cost. |
| `medium` | **Recommended.** Adds control-flow flattening, dead code and encoded strings. |
| `high` | Stronger transformations; larger and slower code. |
| `max` | Everything, plus protection against reformatting. Heaviest. |

Every obfuscated file is checked: the global variables of classic scripts and the imports/exports of modules must stay the same, or that file is published unobfuscated with a warning. Options that change behavior (`debugProtection`, `disableConsoleOutput`, `renameGlobals`) are never enabled automatically; pass them explicitly: `"obfuscate": { "preset": "high", "debugProtection": true }`. License comments (`/*! … */`, `@license`) are preserved.

## TypeScript

Reference `.ts` files from your HTML — or the `.js` name, as TypeScript recommends — and build. No extra install.

```html
<script type="module" src="js/main.ts"></script>
```

- `.ts`, `.mts` and `.cts` files are transpiled with esbuild using your `tsconfig.json`. Types are removed; the syntax level is kept.
- The output is `.js` (`.mjs`, `.cjs`) and the HTML is updated to point to it.
- These keep working: `import './util'`, `import './util.ts'`, `import './util.js'` (when the file is `util.ts`), `import './components'` (folder with `index.ts`) and `new URL('./worker.ts', import.meta.url)`.
- `.d.ts` and `*.test.ts` files are not published.
- Types are not checked. Run `tsc --noEmit` in your editor or CI for that.

## Configuration

Everything works without configuration. To change defaults, create `builder.config.json` in the project folder (`npx builder init` writes one based on your project). Every option can also be set from the command line, which takes precedence. Misspelled options are rejected with a suggestion.

```json
{
  "outDir": "dist",
  "obfuscate": "medium",
  "hash": true,
  "compress": true,
  "ignore": ["drafts/**"],
  "js": { "drop": ["console", "debugger"] }
}
```

`builder.config.mjs` is also accepted; it can export an object or a function (sync or async) that returns one.

### All options

| Option | Default | Description |
| --- | --- | --- |
| `root` | `"."` | Project folder, relative to the config file. |
| `outDir` | `"dist"` | Output folder. Builder refuses to empty a folder it did not create. |
| `entries` | `"auto"` | `"auto"` uses every complete HTML page. Or a list of `.html`, `.js` or `.css` files/patterns. |
| `include` | `[]` | Patterns always published, even if nothing references them (e.g. `"data/**"`). |
| `ignore` | `[]` | Patterns never published (e.g. `"drafts/**"`). |
| `defaultIgnore` | `true` | Exclude secrets (`.env*`, `*.pem`, `*.key`), `node_modules`, `package.json`, lockfiles, tool configs, tests and `.d.ts`. |
| `unreferenced` | `"process"` | Files nothing references: `"process"` (minify and publish), `"copy"` (publish as is) or `"skip"`. |
| `base` | `"/"` | Public base path of the site, for absolute URLs (`"/shop/"`). |
| `hash` | `false` | Content hash in JS/CSS file names (`assets/app-3f9a1c2b.js`). |
| `sourcemap` | `false` | `true` (linked `.map` files), `"hidden"` (no comment in the code) or `"inline"`. |
| `compress` | `false` | `true` (gzip and brotli), `"gzip"` or `"brotli"`: precompressed copies next to each file. |
| `sri` | `"auto"` | Subresource Integrity. `"auto"` recomputes existing `integrity` attributes; `true` also adds them to every local script and stylesheet; `false` removes them. |
| `verify` | `true` | Verify the output before publishing. Turning it off is not recommended. |
| `clean` | `true` | Replace `outDir` completely. With `false`, new files are copied over the existing ones. |
| `cache` | `true` | Reuse results from previous builds. |
| `workers` | `"auto"` | Threads for obfuscation and terser: `"auto"`, a number, or `0` for none. |
| `browsers` | `"auto"` | Target browsers: `"auto"` reads `.browserslistrc` or `browserslist` in `package.json`; or a query (`"> 0.5%, not dead"`); or `false`. Applies to `css.target` and `js.target` when they are at their defaults. Needs `browserslist`. |
| `images` | `false` | `true` or `{ "quality": 1-100 }`: optimize PNG (lossless), JPEG and WebP. Needs `sharp`. |
| `budgets` | `false` | Size limits by output pattern or `"total"`: `{ "js/*.js": "50 KB", "total": "1 MB gzip" }`. Over budget = failed build. |
| `plugins` | `[]` | See [Plugins](#plugins). |
| `obfuscate` | `false` | `false`, `true` (= `"medium"`), `"low"`, `"medium"`, `"high"`, `"max"`, or an object of [javascript-obfuscator options](https://github.com/javascript-obfuscator/javascript-obfuscator#javascript-obfuscator-options) with an optional `preset`. |
| `dependencies.detect` | `true` | Detect third-party libraries automatically. |
| `dependencies.include` | `[]` | Patterns that are libraries (not obfuscated). |
| `dependencies.exclude` | `[]` | Patterns that are your code (obfuscated even if they look like a library). |
| `dependencies.obfuscate` | `false` | Obfuscate libraries too. |
| `html.minify` | `true` | Minify HTML. |
| `html.removeComments` | `true` | Remove HTML comments. Meaningful ones are kept: `<!--! … -->`, IE conditionals, SSI and ESI. |
| `html.collapseWhitespace` | `"auto"` | Collapse whitespace between tags. `"auto"` turns it off if your CSS uses `white-space: pre`. |
| `css.minify` | `true` | Minify CSS. |
| `css.bundle` | `true` | Inline `@import`ed files. |
| `css.target` | `"esnext"` | CSS syntax target, e.g. `["chrome90", "safari15"]`. |
| `js.minify` | `true` | Minify JavaScript. |
| `js.bundle` | `true` | Bundle ES modules. With `false`, each module is minified in place. |
| `js.target` | `"auto"` | `"auto"` keeps the syntax level of your code; or `"es2018"`, `["chrome90", "safari15"]`… |
| `js.minifier` | `"esbuild"` | `"terser"` adds a second, stronger compression pass. |
| `js.mergeClassic` | `"auto"` | Merge consecutive classic `<script>` tags when it is safe (off when source maps are on). |
| `js.drop` | `[]` | Remove `"console"` and/or `"debugger"`. |
| `js.keepNames` | `false` | Keep function and class names (`fn.name`). |
| `js.define` | `{}` | Replace global identifiers at build time, e.g. `{ "DEBUG": "false" }`. |
| `js.legalComments` | `"eof"` | Where license comments go: `"eof"`, `"inline"` or `"none"`. |
| `js.chunkDir` | `"assets"` | Folder for shared chunks, hashed files and vendor packages. |
| `json.minify` | `true` | Remove whitespace from `.json` and `.webmanifest` (values are never rewritten). |

## Plugins

For anything Builder does not do on its own. A plugin is an object with hooks; declare it in `builder.config.mjs`:

```js
// builder.config.mjs
export default {
  plugins: [
    {
      name: 'version',
      filter: /\.(html|js)$/,                  // optional: which files transform() sees
      transform: ({ path, code }) => code.replaceAll('__VERSION__', '1.4.0'),
      buildStart: ({ config, mode }) => {},     // before anything is read
      buildEnd: ({ result, outDir }) => {},     // after dist/ is written (build only)
    },
  ],
};
```

- `transform` receives the **source** of each HTML, CSS, JS and TS file and returns the new code (or nothing to leave it). It runs before processing, so hashes, SRI and the final verification all see the plugin's result.
- In `builder.config.json`, name an installed package instead: `"plugins": ["my-plugin", ["other-plugin", { "option": 1 }]]`. The package exports the plugin object, or a function that receives the options and returns it.
- If a plugin throws, the build stops with a message naming the plugin and the file.

## GitHub Action

```yaml
# .github/workflows/build.yml
on: [push, pull_request]
permissions:
  contents: read
  pull-requests: write   # only for comment: true
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: MarioACo/vanilla-builder@v0.3.0
        with:
          args: --hash --compress     # any build options
          comment: true               # size report on pull requests
```

It builds with a cache kept between runs, writes a size summary on the run page, comments on pull requests (updating the same comment on each push) and fails the job when the build, the verification or a budget fails. Inputs: `directory`, `args`, `version` (when the project does not install vanilla-builder), `node-version`, `cache`, `comment`. Outputs: `total-size`, `total-gzip`, `report` (path to the JSON report).

## Command-line reference

```text
builder <command> [folder] [options]
```

| Command | Description |
| --- | --- |
| `build` | Build the project into `dist/`. |
| `dev` | Build, watch for changes, serve `dist/` and reload the browser. |
| `serve` | Serve the existing `dist/`. |
| `analyze` | Show what would happen to every file. Writes nothing. |
| `deps` | List which JavaScript files are libraries and which are yours. |
| `deps add\|own\|reset <pattern…>` | Mark files as libraries, as your code, or back to automatic. Use `--dir <folder>` for another project. |
| `init` | Create `builder.config.json` from what was detected (`--force` to overwrite). |
| `help`, `--version` | Help and version. |

### Build options

| Option | Description |
| --- | --- |
| `--out <folder>` | Output folder (default `dist`). |
| `--config <file>` | Configuration file (default `builder.config.json`). |
| `--entry <file>` | Explicit entry point. Repeatable. |
| `--include <pattern>` / `--ignore <pattern>` | Always publish / never publish. Repeatable. |
| `--obfuscate [level]` | Obfuscate your JavaScript: `low`, `medium` (default), `high`, `max`. |
| `--dep <pattern>` / `--not-dep <pattern>` | Mark as library / as your code. Repeatable. |
| `--obfuscate-deps` | Obfuscate libraries too. |
| `--minifier terser` | Extra compression pass with terser. |
| `--compress [gzip\|brotli]` | Write precompressed `.gz`/`.br` files (both by default). |
| `--hash` | Content hash in JS/CSS file names. |
| `--sourcemap [linked\|hidden\|inline]` | Generate source maps. |
| `--target <target>` | JavaScript target, e.g. `es2018`. |
| `--drop-console` | Remove `console.*` and `debugger`. |
| `--no-minify` | Do not minify (useful to debug a problem). |
| `--no-merge` | Do not merge classic scripts. |
| `--unreferenced <mode>` | `process`, `copy` or `skip`. |
| `--base <path>` | Public base path, e.g. `/shop/`. |
| `--workers <n\|auto>` | Number of threads (`0` = none). |
| `--browsers <query>` / `--no-browsers` | Target browsers (browserslist query) / ignore the project's browsers. |
| `--images`, `--image-quality <1-100>` | Optimize images (needs `sharp`). |
| `--budget <pattern=size>` | Size budget, e.g. `"total=1MB gzip"`. Repeatable; replaces the configured budgets. |
| `--lang <en\|es>` | Message language. |
| `--no-cache` | Ignore the cache. |
| `--no-verify` | Skip the final verification (not recommended). |
| `--force` | Allow emptying an output folder Builder did not create. |
| `--keep-failed` | Keep the temporary folder if verification fails, to inspect it. |
| `--json` | Machine-readable result. |
| `--verbose` / `--quiet` | More detail (notes, copied and excluded files) / errors only. |

`dev` and `serve` also accept `--port <n>` (default `5173`), `--host <host>` (default `127.0.0.1`) and `--open`. Unknown options are rejected with a suggestion (`--obfusacte` → did you mean `--obfuscate`?).

## Safety guarantees

| Common build-tool risk | What vanilla-builder does |
| --- | --- |
| Merging classic scripts breaks shared globals | Merges only consecutive scripts with the same `defer` and strict mode, without `document.currentScript` or conflicting `let`/`const`, using a safe separator. |
| Minification renames or adds globals | Compares globals before and after; falls back to a safer minification, or keeps the original. |
| Obfuscation breaks a module | Compares imports, exports and import attributes after obfuscating; on mismatch, the file is published unobfuscated. |
| HTML minification changes text | Structural comparison of elements, attributes and text; `<pre>`, `<textarea>` and templates untouched. |
| Stale `integrity` attributes block scripts | Recomputed whenever the content changes. |
| Legacy encodings or BOM get corrupted | HTML bytes are preserved; JS and CSS are emitted with ASCII escapes. |
| JSON numbers lose precision | Only whitespace outside strings is removed. |
| Deleting the wrong folder | Never empties a folder it did not create (marked by `.builder-manifest.json`), the project folder, your home folder or a drive root. |
| A failed build leaves a broken site | Output is written and verified in a temporary folder before replacing `dist/`. |
| Publishing secrets | `.env*`, keys, `node_modules`, `package.json` and tool configs are excluded by default. |

Every release is tested by opening example sites — original and built — in a real Chromium and requiring identical behavior with no console errors and no 404s, in five variants (default, high obfuscation + hash, max obfuscation, terser + precompression, unminified), building with Node 16 and with current Node.

## Performance

Measured with `npm run bench` on a generated site with 40 pages, 240 modules, 120 classic scripts, 30 CSS files and 200 images (median of 3 runs; Intel i7-11700F, Node 24, Windows):

| Build | First build | Rebuild (cache) | v0.1.0 |
| --- | ---: | ---: | ---: |
| Default | 1.9 s | 1.4 s | 3.7 s |
| `--obfuscate` | 7.0 s | 1.8 s | 11.5–17.9 s |
| `--hash --compress` | 2.1 s | 1.1 s | 2.6–3.8 s |
| `--minifier terser` | 3.7 s | 1.6 s | 5.6–6.0 s |

- **Threads.** Obfuscation, terser and the final syntax check run in worker threads (`"auto"` ≈ physical cores, up to 8). Threads start only when there is enough work to pay for their startup, so small projects are not slower.
- **Persistent cache.** Slow results are stored by content in `node_modules/.cache/vanilla-builder` (or the system temp folder). Same input, options and tool versions produce the same output byte for byte — the test suite checks it. Override the location with `BUILDER_CACHE_DIR`; disable with `--no-cache`.
- **Deterministic.** Independent files are processed in parallel but registered in their original order, so the output never depends on timing.
- To see where time goes in your project, look at `perf.phases` in `--json`.

## JavaScript API

```js
import { build, analyze } from 'vanilla-builder';

const result = await build({
  dir: 'my-site',                       // project folder (default: current folder)
  overrides: { obfuscate: 'high' },     // same shape as builder.config.json
});

console.log(result.report.totals);      // { before, size, gzip, brotli, files }
console.log(result.warnings);           // string[]
console.log(result.dependencies);       // [{ rel, reason }]
```

- `build(options)` builds and writes `outDir`. Options: `dir`, `config` (path to a config file), `overrides`, `force`, `keepFailed`, `log` (function called with progress messages).
- `analyze(options)` returns the same result without writing anything.
- Errors are thrown as `BuildError` (exported), with a `details` array.
- `startServer({ dir, port, host })` serves a folder, as `builder serve` does.

## Troubleshooting

### `The output folder … already has files and was not created by Builder`

Builder never empties a folder it did not create. Choose another folder with `--out`, empty it yourself, or pass `--force` if you are sure.

### `Missing optional package "javascript-obfuscator"` (or `terser`, `browserslist`, `sharp`)

Install it in your project, e.g. `npm install --save-dev javascript-obfuscator`. These are optional so the base install stays small.

### `target browsers are set in package.json (browserslist), but the "browserslist" package is missing`

Your project declares browsers (maybe for another tool) but `browserslist` is not installed, so Builder keeps your code as it is. Install it (`npm install --save-dev browserslist`) to use them, or set `"browsers": false` to silence the warning.

### A file is missing from `dist/`

Run `npx builder analyze --verbose`. It lists every file with its destination, and every excluded file with the reason. Files excluded by default (secrets, configs, tests) can still be published with `--include "<pattern>"`.

### A library was obfuscated, or my code was not

Run `npx builder deps` to see the reason for each file, then correct it with `data-builder`, a `@builder-*` comment or `npx builder deps add|own` ([details](#check-and-correct-the-detection)).

### `Two different results want to be written to …`

This usually means a folder in your project has the same name as `js.chunkDir` (`assets` by default), or the same module is used under different import maps. Set `js.chunkDir` to another name.

### `"base" must start with "/"` when using Git Bash on Windows

Git Bash converts arguments that look like Unix paths, so `--base /shop/` arrives as `C:/Program Files/Git/shop/`. Put `"base": "/shop/"` in `builder.config.json`, or run `MSYS_NO_PATHCONV=1 npx builder build --base /shop/`. PowerShell and cmd are not affected.

### Something behaves differently after the build

Build with `--no-minify` to rule out minification, or without `--obfuscate` to rule out obfuscation. If you find a difference, please [open an issue](https://github.com/MarioACo/vanilla-builder/issues) with the smallest example you can share.

## Known limitations

- No obfuscator makes code impossible to read; it only makes it much more expensive to understand.
- With `hash`, JS and CSS are renamed. If your code requests one of them by a path written as text, the original path is published too and you get a warning.
- Collapsing HTML whitespace changes `textContent` but not what is displayed. To keep HTML text byte for byte, set `"html": { "collapseWhitespace": false }`.
- `import()` with a fully computed path makes that group of modules minify file by file instead of bundling, so paths keep working.
- TypeScript: no type checking, no `.tsx`/JSX, and source maps point to the type-stripped JavaScript.
- `--images` re-encodes JPEG and WebP with loss (PNG is lossless). Modern formats (WebP/AVIF from JPEG) are not generated, because that would require changing your HTML.

## Contributing

Issues and pull requests are welcome.

```bash
git clone https://github.com/MarioACo/vanilla-builder.git
cd vanilla-builder
npm install
npm test               # unit and integration tests (Node 18+; on Node 16: npm run test:node16)
npm run test:browser   # original vs built sites in Chromium (uses Chrome/Edge or BUILDER_CHROMIUM)
npm run bench          # performance on a generated site
cd bench/compare && npm install && node run.mjs   # comparison with Parcel and Vite
```

## License

[MIT](LICENSE) © MarioACo
