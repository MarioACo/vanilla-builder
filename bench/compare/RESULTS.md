# vanilla-builder vs Parcel vs Vite

Run on 2026-11-09 · 11th Gen Intel(R) Core(TM) i7-11700F @ 2.50GHz · Node v24.16.0 · win32
Versions: vanilla-builder 0.3.0, Parcel 2.16.4, Vite 8.3.5. Default settings; every HTML page passed as an entry.

## Does the built site behave like the original?

Each test site is opened in Chromium before and after building. A page counts as identical when it reports the same results, with no new console errors and no new failed requests.

| Site | vanilla-builder | Parcel | Vite |
| --- | --- | --- | --- |
| `classic` | ✅ 2/2 | ❌ 0/2 | ❌ 0/2 |
| `modules` | ✅ 2/2 | ❌ 0/2 | ❌ 0/2 |
| `npm` | ✅ 1/1 | ✅ 1/1 | ❌ 0/1 |

<details><summary>What broke</summary>

- **parcel**, `classic`: build failed: @parcel/transformer-js: Constructing a Worker with a string literal is not supported.   js\app2.js:6:29     5 \|   document.getElementById('btn').click();
- **vite**, `classic`: index.html: different results: inlineOk, iife, estricto, currentScript
- **vite**, `classic`: index.html: error: sumar is not defined
- **vite**, `classic`: index.html: error: no terminó: page.waitForFunction: Timeout 15000ms exceeded.
- **vite**, `classic`: index.html: failed request: /js/vendor/mini-lib.js (404)
- **vite**, `classic`: index.html: failed request: /js/vendor/mini-lib.js (net::ERR_ABORTED)
- **vite**, `classic`: index.html: failed request: /js/util.js (404)
- **parcel**, `modules`: build failed: @parcel/transformer-js: Registering service workers with a string literal is not supported.   js\main.js:34:57     33 \|
- **vite**, `modules`: build failed: [MISSING_EXPORT] "default" is not exported by "css/hoja.css".
- **vite**, `npm`: index.html: different results: lib, extra, compartido, clasico
- **vite**, `npm`: index.html: error: Mini is not defined
- **vite**, `npm`: index.html: error: no terminó: page.waitForFunction: Timeout 15000ms exceeded.
- **vite**, `npm`: index.html: failed request: /js/vendor/mini.min.js (404)
- **vite**, `npm`: index.html: failed request: /js/vendor/mini.min.js (net::ERR_ABORTED)
- **vite**, `npm`: index.html: failed request: /js/app-clasico.js (404)

</details>

## Build time and size (generated site, 3 runs, cold, no cache)

Source: 673 files, 515.0 KB.

Sample pages checked in Chromium: index.html, page1.html, page20.html (no page errors, no failed requests, the module script ran).

| Tool | Time (median) | Output files | Output size | gzip (text files) | Sample pages work? |
| --- | ---: | ---: | ---: | ---: | --- |
| vanilla-builder | 1.16 s | 555 | 441.8 KB | 156.6 KB | ✅ |
| parcel | 2.12 s | 271 | 684.9 KB | 102.6 KB | ✅ |
| vite | 0.29 s | 96 | 282.6 KB | 56.5 KB | ❌ 12 problem(s), e.g. index.html: 404 /js/vendor/acorn.js |
| vanilla-builder (unreferenced: skip) | 1.20 s | 223 | 289.2 KB | 64.8 KB | ✅ |

Output files and size are only comparable between tools whose sample pages work: a smaller output can mean files were left out.
vanilla-builder also publishes files nothing references (`unreferenced: "process"`), which the others drop; set `"unreferenced": "skip"` to compare like for like.

Reproduce: `cd bench/compare && npm install && node run.mjs`.
