# TypeScript

A small todo list written in TypeScript, with no extra setup: the HTML points at `src/main.ts`.

```bash
npx vanilla-builder build
npx vanilla-builder serve
```

What to look at:

- `dist/index.html` now loads `src/main.js`; there are no `.ts` files in `dist/`.
- `./todos` (no extension), `./utils/format.js` (the file is `format.ts`) and `import type` all work.
- `builder.config.json` sets target browsers: the nested CSS in `styles.css` is flattened for the browsers that need it (requires `npm i -D browserslist`; without it Builder warns and keeps your CSS as is).
- Builder does not check types. Run `npx tsc --noEmit` for that.
