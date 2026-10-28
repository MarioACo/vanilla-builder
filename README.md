# Builder

Empaqueta, minifica y ofusca proyectos web **vanilla** (HTML, CSS y JavaScript sin framework) **sin perder nada**.
Detecta solo las dependencias de cada página, verifica la salida antes de publicarla y nunca borra lo que no creó.

- **Cero configuración**: apúntalo a una carpeta con `.html` y listo.
- **Sin pérdida**: cada archivo del proyecto termina con un destino conocido (procesado, empaquetado, copiado u omitido a propósito) y la salida se verifica antes de reemplazar `dist/`.
- **Ligero**: 57 KB propios; la instalación base son 8 paquetes (el grueso es el binario de esbuild). El ofuscador y terser se instalan solo si los usas.
- **Node 16 o superior** (probado en 16, 18, 20, 22 y 24).

## Instalación

```bash
npm install --save-dev vanilla-builder          # o: npm link desde esta carpeta
npm install --save-dev javascript-obfuscator    # solo si vas a ofuscar
npm install --save-dev terser                   # solo si quieres la compresión máxima
```

> En Node 16 y 17, npm muestra un aviso `EBADENGINE` porque esbuild declara Node 18+. Es solo un aviso:
> toda la batería de pruebas (incluidas las de navegador) pasa compilando con Node 16.

## Uso

```bash
builder build mi-sitio                  # compila en mi-sitio/dist
builder build mi-sitio --obfuscate      # además ofusca tu JavaScript (nivel medium)
builder analyze mi-sitio                # muestra qué pasará con cada archivo, sin escribir nada
builder init mi-sitio                   # crea builder.config.json con lo detectado
builder dev mi-sitio                    # compila, vigila cambios y sirve dist/ con recarga automática
builder serve mi-sitio                  # sirve dist/ para probarlo
```

Opciones frecuentes de `build` (todas tienen equivalente en la configuración):

| Opción | Qué hace |
| --- | --- |
| `--obfuscate [low\|medium\|high\|max]` | Ofusca tu JS. Las librerías de terceros se detectan y no se tocan. |
| `--dep <patrón>` / `--not-dep <patrón>` | Marca a mano una dependencia / corrige una detección. |
| `--obfuscate-deps` | Ofusca también las dependencias. |
| `--minifier terser` | Segunda pasada de compresión con terser (JS aún más pequeño). |
| `--compress [gzip\|brotli]` | Genera además `.gz` y `.br` para servidores que sirven precomprimido. |
| `--hash` | Nombres con hash en JS/CSS para caché a largo plazo. |
| `--sourcemap [linked\|hidden\|inline]` | Source maps. |
| `--target es2018` | Transpila a un nivel concreto (por defecto: el del propio código). |
| `--drop-console` | Quita `console.*` y `debugger`. |
| `--entry`, `--include`, `--ignore` | Entradas explícitas, archivos forzados y excluidos (repetibles). |
| `--json` | Resultado en JSON para CI (código de salida 1 si algo falla). |

## Qué detecta solo

Partiendo de cada `.html`, Builder sigue:

- `<script src>` clásicos y `type="module"`, scripts inline e **import maps**.
- `<link rel="stylesheet">`, `@import` y `url()` del CSS (también `image-set()`), `<style>` y atributos `style`.
- Imágenes, `srcset`, vídeo, audio, iconos, manifest, `og:image`, `<iframe>`, `<object>`, SVG `<use>`…
- Enlaces a otras páginas, `import()` dinámicos, `new URL('./x', import.meta.url)`.
- Workers, service workers e `importScripts()`.
- Rutas escritas como texto en el JS (por ejemplo la lista de precache de un service worker): esos archivos se publican también en su ruta original.

Lo que no se puede seguir (un `fetch(variable)`, una plantilla del servidor…) **no se pierde**: la estructura de carpetas se conserva y todo lo no referenciado se publica igualmente (`unreferenced: "process"`).

## Garantías

| Riesgo típico de un builder | Cómo lo evita Builder |
| --- | --- |
| Unir scripts clásicos rompe variables globales | Solo une scripts consecutivos, con el mismo `defer`/modo estricto, sin `document.currentScript`, sin redeclarar `let/const` y con separador seguro (`;`). |
| La minificación crea globales nuevas o renombra las tuyas | Compara las globales antes y después; si cambian, usa una minificación más conservadora o deja el original. |
| El ofuscador rompe exportaciones o atributos `with { type }` | Verifica exportaciones, importaciones y atributos tras ofuscar; si no cuadran, no ofusca ese archivo. |
| esbuild borra en silencio `with { type: 'css' }` | Se fuerza la conservación de los atributos de import. |
| La minificación HTML cambia el texto | Minificador propio sobre parse5 y comprobación estructural (elementos, atributos y texto). `<pre>`, `<textarea>` y plantillas quedan intactos; si el CSS usa `white-space: pre`, no colapsa espacios. |
| `integrity` (SRI) obsoleto bloquea scripts | Se recalcula al cambiar el contenido. |
| Codificaciones antiguas o BOM | Se conservan los bytes (HTML) o se emite JS/CSS con escapes ASCII. |
| JSON reformateado pierde precisión | Solo se quitan espacios fuera de las cadenas: `2.0` y números enormes quedan igual. |
| Borrar `dist/` equivocado | Nunca vacía una carpeta que no creó (marca `.builder-manifest.json`), ni la del proyecto, ni la raíz. |
| Compilación fallida a medias | Se escribe en una carpeta temporal, se verifica y solo entonces reemplaza `dist/`. |
| Publicar secretos | `.env*`, claves `.pem/.key`, `node_modules`, `package.json` y configuración de herramientas quedan fuera por defecto. |

La batería de pruebas abre cada sitio de ejemplo **original y compilado en Chromium** y exige resultados idénticos, sin errores ni 404, con 5 variantes (por defecto, ofuscación alta + hash, ofuscación max, terser + precompresión, sin minificar).

## Dependencias de terceros y ofuscación

Ofuscar jQuery, Bootstrap o un paquete de npm no protege nada tuyo, los hace más lentos y puede incumplir su licencia. Por eso, al ofuscar:

- Se detectan como dependencia los archivos en `vendor/`, `node_modules/`, `third-party/`…, los nombres de librerías conocidas (`jquery-3.7.1.min.js`, `bootstrap.bundle.js`…), los `.min.js`/`.umd.js`, el código ya minificado y las cabeceras de licencia con versión (`/*! Foo v1.2.0 */`).
- Los paquetes de npm que importa tu código de módulos se separan en `assets/vendor/` (sin ofuscar y con su estado compartido intacto).
- `builder analyze` lista qué detectó y por qué.

Para corregirlo a mano:

```json
{
  "obfuscate": "high",
  "dependencies": {
    "include": ["js/mi-libreria.js"],
    "exclude": ["js/app.min.js"],
    "obfuscate": false
  }
}
```

`include` marca dependencias que no se detectaron; `exclude` indica que un archivo es tuyo y sí debe ofuscarse; `obfuscate: true` ofusca todo.

Niveles: `low` (casi sin coste), `medium` (recomendado), `high` y `max` (además se defiende de ser formateado o modificado; más pesado y lento). Las opciones que cambian el comportamiento (`debugProtection`, `disableConsoleOutput`, `renameGlobals`) nunca se activan solas; puedes pasarlas con un objeto: `"obfuscate": { "preset": "high", "debugProtection": true }`. Tus comentarios de licencia (`/*! … */`, `@license`) se conservan.

## Configuración (`builder.config.json`)

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

- `entries`: `"auto"` toma todos los HTML completos; también admite una lista de `.html`, `.js` o `.css`.
- `unreferenced`: qué hacer con lo que nada referencia: `process` (minificar y publicar), `copy` o `skip`.
- `js.target: "auto"` usa el nivel de sintaxis de tu propio código: no transpila ni introduce sintaxis más nueva que la que ya usas.
- También se acepta `builder.config.mjs` (exporta un objeto o una función). Las opciones mal escritas dan error con sugerencia.

## API

```js
import { build, analyze } from 'vanilla-builder';

const result = await build({ dir: 'mi-sitio', overrides: { obfuscate: 'high' } });
console.log(result.report.totals, result.warnings);
```

## Desarrollo

```bash
npm test               # unitarias + integración (Node 18+; en Node 16: npm run test:node16)
npm run test:browser   # equivalencia real en Chromium (busca Chrome/Edge o usa BUILDER_CHROMIUM)
BUILDER_NODE=/ruta/node16 npm run test:browser   # compila con otro Node y verifica en el navegador
```

## Límites conocidos

- Ningún ofuscador hace el código imposible de leer: solo lo encarece mucho.
- Con `hash: true`, los JS/CSS cambian de nombre; si tu código los pide por texto, Builder publica también la ruta original y lo avisa.
- Colapsar espacios en HTML cambia `textContent` (no lo que se ve). Para conservarlo byte a byte: `"html": { "collapseWhitespace": false }`.
- `import()` con rutas calculadas sin prefijo fijo hace que ese grupo de módulos se minifique archivo por archivo en su sitio (sin empaquetar), para no romper rutas.
