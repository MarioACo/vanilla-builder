# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [0.2.0] - 2026-11-09

### Added

- **TypeScript**: `.ts`, `.mts` and `.cts` files are transpiled with esbuild (using `tsconfig.json`) and published as `.js`; the HTML is rewritten to the output. Extensionless, directory and `.ts` imports, and `new URL('./worker.ts', import.meta.url)`, keep working even without bundling. `.d.ts` and `*.test.ts` are not published.
- **`builder deps`**: lists which JS files are third-party libraries (and why) and which are yours; `builder deps add|own|reset <pattern…>` edits `builder.config.json` safely.
- Mark dependencies without config: `data-builder="dependency|own"` on a `<script>`, or `/* @builder-dependency */` / `/* @builder-own */` at the top of the file.
- New detection signals: UMD/AMD wrappers and files named like a package in `package.json` `dependencies`.
- **Worker threads** for obfuscation, terser and the final syntax check (`workers`, `--workers`), with the main thread helping while they start.
- **Persistent cache** of slow results by content (`cache`, `--no-cache`, `BUILDER_CACHE_DIR`); output is byte-identical with or without it.
- `perf` in the result and in `--json`: tasks, threads, cache hits and milliseconds per phase.
- `npm run bench`: reproducible benchmark on a generated site.

### Changed

- Independent files (classic scripts, standalone files, CSS, module outputs, compression) are processed concurrently and registered in the original order.
- gzip/brotli sizes for the report are computed asynchronously, once, and shared with `--compress`.
- The ES level of each file is computed only when needed; global-variable checks use a single parse.

## [0.1.0] - 2026-11-08

First public release.

### Added

- `builder build | analyze | init | dev | serve` CLI and `build()` / `analyze()` API.
- Dependency discovery from every HTML page: classic and module scripts, import maps, CSS `@import`/`url()`/`image-set()`, media, icons, manifest, workers, service workers, dynamic `import()` and `new URL(..., import.meta.url)`.
- Lossless pipeline: every file gets a known fate, output is built in a temp folder, verified and only then swapped into `dist/`.
- Conservative HTML minifier on parse5 with structural verification.
- JS/CSS bundling and minification with esbuild, optional terser pass, safe merging of classic scripts.
- Optional obfuscation (`low`, `medium`, `high`, `max`) with javascript-obfuscator; third-party libraries are detected and left untouched unless requested.
- Content hashing, source maps, SRI recomputation, gzip/brotli precompression, `--json` output for CI.
- Projects opened through a symlink or junction (e.g. macOS `/tmp`) now build; the root is resolved to its real path.
- MIT license, CI on Node 16–24 (Linux, Windows, macOS) and browser equivalence tests in Chrome.

[0.2.0]: https://github.com/MarioACo/vanilla-builder/releases/tag/v0.2.0
[0.1.0]: https://github.com/MarioACo/vanilla-builder/releases/tag/v0.1.0
