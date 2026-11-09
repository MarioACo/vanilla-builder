# Classic multi-page site

Two HTML pages, classic `<script>` tags that share a global variable, a copied third-party library and CSS split with `@import`.

```bash
npx vanilla-builder analyze     # what will happen to each file
npx vanilla-builder build       # → dist/
npx vanilla-builder serve       # http://127.0.0.1:5173
```

What to look at in `dist/`:

- `state.js` and `app.js` are merged into one file (they share `appState`, and Builder checks the globals stay the same).
- `js/vendor/mini-tabs.min.js` is detected as a library: try `npx vanilla-builder build --obfuscate` and it stays readable while your code is obfuscated (needs `npm i -D javascript-obfuscator`).
- `css/main.css` contains `base.css` and `components.css`; the background image path still works.
- The `<pre>` text on `about.html` keeps its spaces.
