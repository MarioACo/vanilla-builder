# vanilla-builder

[![CI](https://github.com/MarioACo/vanilla-builder/actions/workflows/ci.yml/badge.svg)](https://github.com/MarioACo/vanilla-builder/actions/workflows/ci.yml) [![npm](https://img.shields.io/npm/v/vanilla-builder)](https://www.npmjs.com/package/vanilla-builder) [![MIT](https://img.shields.io/badge/licencia-MIT-blue)](LICENSE)

[English](README.md) · **Español**

Empaqueta, minifica y ofusca proyectos web **vanilla** (HTML, CSS y JavaScript sin framework) **sin perder nada**.
Detecta solo las dependencias de cada página, verifica la salida antes de publicarla y nunca borra lo que no creó.

- **Cero configuración**: apúntalo a una carpeta con `.html` y listo.
- **Sin pérdida**: cada archivo del proyecto termina con un destino conocido (procesado, empaquetado, copiado u omitido a propósito) y la salida se verifica antes de reemplazar `dist/`.
- **Rápido**: la ofuscación y terser van en hilos paralelos, y una caché persistente hace casi gratis recompilar lo que no cambió (sitio de prueba de 40 páginas ofuscado: 11–18 s en 0.1.0 → 7 s la primera vez, 1,8 s al recompilar). Ver [Velocidad](#velocidad).
- **Tú decides qué es una librería**: el código de terceros se detecta y nunca se ofusca; lo corriges desde el HTML, el propio archivo o `builder deps`. Ver [Dependencias](#dependencias-de-terceros-y-ofuscación).
- **TypeScript incluido**: `<script src="app.ts">` funciona tal cual; la salida es `.js`.
- **Ligero**: la instalación base son 8 paquetes (el grueso es el binario de esbuild). El ofuscador y terser se instalan solo si los usas.
- **Node 16 o superior** (probado en 16, 18, 20, 22 y 24, en Linux, Windows y macOS).

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
builder deps mi-sitio                   # qué JS son librerías (no se ofuscan) y cuáles son tuyos
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
| `--workers <n\|auto>` | Hilos para ofuscar/terser (`0` = sin hilos). |
| `--no-cache` | No usa la caché de compilaciones anteriores. |
| `--json` | Resultado en JSON para CI (código de salida 1 si algo falla), con el tiempo de cada fase. |

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

Ofuscar jQuery, Bootstrap o un paquete de npm no protege nada tuyo, los hace más lentos y puede incumplir su licencia. Por eso, al ofuscar, esto se detecta como dependencia y no se toca:

- Archivos en `vendor/`, `node_modules/`, `third-party/`…
- Nombres de librerías conocidas (`jquery-3.7.1.min.js`, `bootstrap.bundle.js`…) y versiones compiladas (`.min.js`, `.umd.js`).
- Archivos que se llaman como un paquete de las `dependencies` de tu `package.json` (`js/chart.umd.js` si dependes de `chart.js`).
- Envoltorios UMD/AMD (el formato en que se publican las librerías), cabeceras de licencia con versión (`/*! Foo v1.2.0 */`) y código ya minificado.
- Los paquetes de npm que importa tu código de módulos se separan en `assets/vendor/` (sin ofuscar y con su estado compartido intacto).

Para ver qué se detectó y por qué:

```bash
builder deps mi-sitio
```

¿Algo mal? Hay tres formas de corregirlo; usa la que te resulte más cómoda:

```html
<!-- 1. En el HTML -->
<script src="js/mi-lib.js" data-builder="dependency"></script>
<script src="js/app.min.js" data-builder="own"></script>
```

```js
/* 2. Al principio del propio archivo */
/* @builder-dependency */   // o: /* @builder-own */
```

```bash
# 3. Desde la terminal (edita builder.config.json por ti y conserva el resto)
builder deps add "js/libs/**"     # son librerías: no ofuscar
builder deps own js/app.min.js    # es mi código: ofuscarlo
builder deps reset js/app.min.js  # volver a la detección automática
```

La configuración tiene la última palabra sobre las marcas, y las marcas sobre la detección automática:

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

## TypeScript

Apunta tu HTML a archivos `.ts` (o al nombre `.js`, como recomienda el propio TypeScript) y compila:

```html
<script type="module" src="js/main.ts"></script>
```

- Cada `.ts`/`.mts`/`.cts` se transpila con esbuild usando tu `tsconfig.json` (se quitan los tipos, el nivel de sintaxis no cambia) y luego pasa por el mismo proceso que el JavaScript: empaquetado, ofuscación y verificación.
- La salida es `.js` (`.mjs`/`.cjs`) y el HTML se reescribe para apuntar a ella. Siguen funcionando `import './x.ts'`, `import './x'`, `import './carpeta'` y `new URL('./worker.ts', import.meta.url)`.
- Los `.d.ts` y los `*.test.ts` no se publican.
- Builder no comprueba tipos: para eso, ejecuta `tsc --noEmit` en tu CI.

## Velocidad

Medido con `npm run bench` (un sitio generado con 40 páginas, 240 módulos, 120 scripts clásicos, 30 CSS y 200 imágenes; mediana de 3 ejecuciones en un i7-11700F, Node 24, Windows):

| Compilación | 0.1.0 | 0.2.0, primera vez | 0.2.0, recompilar (caché) |
| --- | ---: | ---: | ---: |
| Por defecto | 3,7 s | 1,9 s | 1,4 s |
| `--obfuscate` | 11,5–17,9 s | 7,0 s | 1,8 s |
| `--hash --compress` | 2,6–3,8 s | 2,1 s | 1,1 s |
| `--minifier terser` | 5,6–6,0 s | 3,7 s | 1,6 s |

Cómo:

- **Hilos**: la ofuscación, terser y la comprobación final de sintaxis van en hilos de trabajo (`workers: "auto"` ≈ núcleos físicos, máximo 8). El hilo principal también trabaja, y los hilos solo arrancan cuando hay suficiente trabajo en cola para compensar su arranque, así que un proyecto pequeño nunca va más lento.
- **Caché persistente**: los resultados se guardan por contenido en `node_modules/.cache/vanilla-builder` (o en el temporal del sistema). Misma entrada + mismas opciones + mismas versiones = misma salida, byte a byte; las pruebas lo comprueban. Con `BUILDER_CACHE_DIR` puedes conservarla entre ejecuciones de CI. `--no-cache` o `"cache": false` la desactivan.
- **En paralelo y en orden**: los archivos independientes se procesan a la vez, pero se registran en el orden original, así que la salida no depende de los tiempos.
- `--json` incluye `perf.phases` (milisegundos por fase) para ver dónde se va el tiempo en tu proyecto.

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
  "cache": true,
  "workers": "auto",
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
npm run bench          # velocidad sobre un sitio generado, primera vez y con caché
npm run test:browser   # equivalencia real en Chromium (busca Chrome/Edge o usa BUILDER_CHROMIUM)
BUILDER_NODE=/ruta/node16 npm run test:browser   # compila con otro Node y verifica en el navegador
```

## Límites conocidos

- Ningún ofuscador hace el código imposible de leer: solo lo encarece mucho.
- Con `hash: true`, los JS/CSS cambian de nombre; si tu código los pide por texto, Builder publica también la ruta original y lo avisa.
- Colapsar espacios en HTML cambia `textContent` (no lo que se ve). Para conservarlo byte a byte: `"html": { "collapseWhitespace": false }`.
- `import()` con rutas calculadas sin prefijo fijo hace que ese grupo de módulos se minifique archivo por archivo en su sitio (sin empaquetar), para no romper rutas.
- TypeScript: no se comprueban tipos, no hay `.tsx`/JSX, y los source maps apuntan al JavaScript ya sin tipos, no a las líneas del `.ts`.

## Licencia

[MIT](LICENSE) © MarioACo
