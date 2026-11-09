# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

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

[0.1.0]: https://github.com/MarioACo/vanilla-builder/releases/tag/v0.1.0
