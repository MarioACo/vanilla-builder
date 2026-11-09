# Protected app

ES modules with business logic you want to obfuscate, a third-party module that must stay readable, hashed file names, precompressed output and size budgets.

```bash
npm install
npm run deps     # js/vendor/money-format.js is a library; js/main.js and js/pricing.js are yours
npm run build
```

What to look at:

- `builder.config.json` turns on obfuscation, hashing, precompression and two budgets.
- In `dist/`, your code is obfuscated; `money-format.js` is not (it is in `vendor/` and has a license header with a version).
- `.gz` and `.br` files sit next to each output for servers that serve precompressed files.
- Lower a budget (for example `"total": "1 KB gzip"`) and the build fails without touching `dist/`.
