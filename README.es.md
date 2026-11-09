# vanilla-builder

[![CI](https://github.com/MarioACo/vanilla-builder/actions/workflows/ci.yml/badge.svg)](https://github.com/MarioACo/vanilla-builder/actions/workflows/ci.yml) [![npm](https://img.shields.io/npm/v/vanilla-builder)](https://www.npmjs.com/package/vanilla-builder) [![Node](https://img.shields.io/badge/node-%3E%3D16-brightgreen)](#requisitos) [![MIT](https://img.shields.io/badge/licencia-MIT-blue)](LICENSE)

[English](README.md) · **Español**

**Compilación de producción para sitios hechos con HTML, CSS y JavaScript sin framework: sin configuración y sin perder nada.**

Apúntalo a una carpeta con archivos `.html`. Encuentra cada script, hoja de estilos, imagen y página que usan; los empaqueta y minifica; puede ofuscar tu JavaScript (sin tocar las librerías de terceros); comprueba el resultado, y solo entonces escribe `dist/`.

```text
mi-sitio/                         mi-sitio/dist/
├── index.html                    ├── index.html          ← minificado, rutas actualizadas
├── contacto.html                 ├── contacto.html
├── css/main.css  (+ @imports)    ├── css/main.css        ← un solo archivo, minificado
├── js/app.js     (+ imports)  →  ├── js/app.js           ← empaquetado, minificado y, si quieres, ofuscado
├── js/vendor/jquery.min.js       ├── js/vendor/jquery.min.js   ← detectado como librería: nunca se ofusca
├── img/…                         ├── img/…               ← copiado tal cual
└── .env                          └── (no se publica: los secretos se excluyen)
```

## Contenido

- [Por qué vanilla-builder](#por-qué-vanilla-builder)
- [Requisitos](#requisitos)
- [Inicio rápido](#inicio-rápido)
- [Tareas habituales](#tareas-habituales)
- [Cómo funciona](#cómo-funciona)
- [Librerías de terceros y ofuscación](#librerías-de-terceros-y-ofuscación)
- [TypeScript](#typescript)
- [Configuración](#configuración)
- [Referencia de la línea de comandos](#referencia-de-la-línea-de-comandos)
- [Garantías de seguridad](#garantías-de-seguridad)
- [Rendimiento](#rendimiento)
- [API de JavaScript](#api-de-javascript)
- [Solución de problemas](#solución-de-problemas)
- [Limitaciones conocidas](#limitaciones-conocidas)
- [Contribuir](#contribuir)

## Por qué vanilla-builder

Herramientas como Vite o webpack dan por hecho una aplicación con un punto de entrada y un grafo de módulos. Muchos sitios reales no son así: varias páginas HTML, etiquetas `<script>` clásicas que comparten variables globales, un `jquery.min.js` copiado a mano, un service worker con una lista de archivos. vanilla-builder está hecho para esos sitios.

- **Cero configuración.** Cada `.html` completo es un punto de entrada. No hay nada que declarar.
- **No se pierde nada.** Cada archivo del proyecto termina con un destino conocido (procesado, empaquetado, copiado o excluido a propósito) y puedes ver cuál. Lo que no se puede rastrear se publica igualmente.
- **Salida verificada.** La compilación se escribe en una carpeta temporal, se comprueba (cada referencia existe, cada JS es válido, cada archivo de origen tiene destino) y solo entonces reemplaza `dist/`. Una compilación fallida nunca te deja un `dist/` roto.
- **Seguro con scripts clásicos.** Solo une o minifica scripts cuando puede demostrar que las variables globales no cambian.
- **Ofuscación que respeta las librerías.** Tu código queda protegido; jQuery, Bootstrap y los paquetes de npm se detectan y se dejan como están. Puedes corregir la detección en una línea.
- **TypeScript sin configurar nada.** `<script src="app.ts">` funciona; la salida es `.js`.
- **Rápido.** Hilos en paralelo y caché persistente: recompilar un sitio de 40 páginas ofuscado tarda menos de 2 segundos ([cifras](#rendimiento)).

## Requisitos

- **Node.js 16 o superior.** Probado en Node 16, 18, 20, 22 y 24, en Linux, Windows y macOS.
- Opcionales, solo si los usas: [`javascript-obfuscator`](https://www.npmjs.com/package/javascript-obfuscator) para `--obfuscate` y [`terser`](https://www.npmjs.com/package/terser) para `--minifier terser`.

En Node 16 y 17, npm muestra el aviso `EBADENGINE` porque esbuild declara Node 18+. Es solo un aviso: toda la batería de pruebas pasa con Node 16.

## Inicio rápido

**1. Instálalo en tu proyecto:**

```bash
npm install --save-dev vanilla-builder
```

**2. Compila:**

```bash
npx builder build
```

El resultado queda en `dist/`. La terminal muestra una tabla con cada archivo de salida y su tamaño antes, después, con gzip y con brotli, y confirma la verificación:

```text
✔ 3 html · 8 js · 1 css · 1 json · 4 svg · 1 text  (0.28 s)
✔ Verificación: 18 archivos escritos, 17 referencias comprobadas, 8 JS válidos, 0 errores
✔ Cobertura: 21/21 archivos de origen con destino conocido
```

**3. Prueba el resultado en el navegador:**

```bash
npx builder serve        # http://127.0.0.1:5173
```

Si quieres, añade scripts a tu `package.json`:

```json
{
  "scripts": {
    "dev": "builder dev",
    "build": "builder build"
  }
}
```

> Los comandos aceptan una carpeta: `npx builder build mi-sitio` compila `mi-sitio/` en `mi-sitio/dist/`. Sin carpeta, se usa la actual.

## Tareas habituales

### Desarrollar con recarga automática

```bash
npx builder dev                 # compila, vigila cambios, sirve dist/ y recarga el navegador
npx builder dev --port 3000 --open
```

### Publicar un sitio estático (Netlify, GitHub Pages, S3, nginx…)

```bash
npx builder build --hash --compress
```

- `--hash` renombra JS y CSS a `nombre-<hash>.js` para que puedas cachearlos para siempre; las referencias del HTML se actualizan.
- `--compress` escribe además `.gz` y `.br` junto a cada archivo, para servidores que sirven archivos precomprimidos (`gzip_static`, `brotli_static` de nginx).

Si el sitio se sirve desde una subcarpeta (`https://ejemplo.com/tienda/`), añade `--base /tienda/` para que las rutas absolutas (`/js/app.js`) funcionen.

### Proteger tu JavaScript

```bash
npm install --save-dev javascript-obfuscator
npx builder build --obfuscate            # nivel medium (recomendado)
npx builder build --obfuscate high
```

Las librerías de terceros se detectan y no se ofuscan. Comprueba qué se detectó con `npx builder deps`; ver [Librerías de terceros](#librerías-de-terceros-y-ofuscación).

### Dejar el JavaScript lo más pequeño posible

```bash
npm install --save-dev terser
npx builder build --minifier terser --drop-console
```

### Ver qué pasará antes de compilar

```bash
npx builder analyze
```

Lista cada archivo con lo que pasará con él, las librerías y workers detectados, las referencias rotas que ya existen en tu código y los archivos excluidos. No escribe nada.

### Usarlo en CI

```bash
npx builder build --json > build-report.json
```

- Código de salida `0` si todo va bien y distinto de cero si la compilación o la verificación fallan; en ese caso `dist/` no se toca y el JSON trae `"ok": false` con el error.
- El JSON incluye salidas, tamaños, avisos, dependencias detectadas y el tiempo de cada fase (`perf.phases`).
- Para reutilizar la caché entre ejecuciones, apunta `BUILDER_CACHE_DIR` a una carpeta que tu CI guarde.

## Cómo funciona

1. **Descubrir.** Se analiza cada página HTML completa. Desde ella, Builder sigue los scripts (clásicos y módulos, inline e import maps), las hojas de estilos (`@import`, `url()`, `image-set()`), imágenes y `srcset`, vídeo y audio, iconos, manifiestos, `og:image`, iframes, enlaces a otras páginas, `import()` dinámicos, `new URL('./x', import.meta.url)`, workers, service workers, `importScripts()` y rutas escritas como texto en tu código (como una lista de precache).
2. **Procesar.**
   - Los módulos ES se empaquetan con [esbuild](https://esbuild.github.io/) (con división en chunks). Se mantiene el nivel de sintaxis de tu propio código: no se transpila nada salvo que lo pidas con `--target`.
   - Los scripts clásicos consecutivos se unen solo cuando es seguro, y después se minifican.
   - El CSS se empaqueta y minifica; el HTML se minifica con un minificador conservador que deja intactos `<pre>`, `<textarea>` y las plantillas.
   - Al JSON solo se le quitan espacios. Todo lo demás (imágenes, fuentes, datos) se copia.
3. **Proteger (opcional).** Se ofusca tu JavaScript; las librerías no.
4. **Verificar.** En una carpeta temporal: cada referencia existe, cada JS es válido, los tamaños coinciden y cada archivo de origen tiene destino.
5. **Publicar.** La carpeta temporal reemplaza a `dist/`.

Los archivos que nada referencia también se minifican y se publican en su ruta original (`unreferenced: "process"`), así que un `fetch(variable)` o una plantilla del servidor que cargue un archivo siguen funcionando.

## Librerías de terceros y ofuscación

Ofuscar jQuery, Bootstrap o un paquete de npm no protege nada tuyo, los hace más lentos y puede incumplir su licencia. Al ofuscar, esto se trata como librería y no se toca:

| Señal | Ejemplo |
| --- | --- |
| Está en una carpeta de librerías | `vendor/`, `node_modules/`, `third-party/`, `external/`… |
| Nombre de librería conocida | `jquery-3.7.1.min.js`, `bootstrap.bundle.js`, `chart.umd.js` |
| Ya viene compilado | `.min.js`, `.umd.js`, o código ya minificado |
| Se llama como un paquete del que dependes | `js/swiper.js` si `package.json` tiene `swiper` en `dependencies` |
| Envoltorio de librería | UMD/AMD (`typeof define === "function" && define.amd`) |
| Cabecera de licencia con versión | `/*! Foo v1.2.0 */` |

Los paquetes de npm que importan tus módulos (`import confetti from 'canvas-confetti'`) se empaquetan desde `node_modules`. Al ofuscar, se separan en archivos aparte en `assets/vendor/`, sin ofuscar y compartidos entre páginas.

### Comprobar y corregir la detección

```bash
npx builder deps
```

```text
Librerías de terceros (no se ofuscan) (2)
  • js/vendor/jquery.min.js — está en vendor/
  • js/slider.js — envoltorio UMD/AMD (formato de librería publicada)

Tu código (se ofusca con --obfuscate) (1)
  • js/app.js
```

Con `--json` obtienes `{ "dependencies": [{ "rel", "reason" }], "own": [] }`.

Si algo está mal clasificado, corrígelo donde te resulte más cómodo:

#### En el HTML

```html
<script src="js/mi-lib.js" data-builder="dependency"></script>   <!-- librería: no ofuscar -->
<script src="js/app.min.js" data-builder="own"></script>         <!-- mi código: ofuscar -->
```

#### Al principio del archivo

```js
/* @builder-dependency */      // o /* @builder-own */
```

#### Desde la terminal

Escribe `builder.config.json` por ti y conserva el resto de tu configuración:

```bash
npx builder deps add "js/libs/**"       # son librerías
npx builder deps own js/app.min.js      # es mi código
npx builder deps reset js/app.min.js    # volver a la detección automática
```

#### En la configuración

```json
{
  "dependencies": {
    "include": ["js/mi-libreria.js"],
    "exclude": ["js/app.min.js"]
  }
}
```

Prioridad: configuración › marcas en el HTML o en el archivo › detección automática. Para ofuscarlo todo, librerías incluidas, usa `--obfuscate-deps` (`"dependencies": { "obfuscate": true }`).

### Niveles de ofuscación

| Nivel | Para qué |
| --- | --- |
| `low` | Renombrado y ocultación de textos. Casi sin coste en ejecución. |
| `medium` | **Recomendado.** Añade aplanado del flujo de control, código muerto y textos codificados. |
| `high` | Transformaciones más fuertes; código más grande y más lento. |
| `max` | Todo, más protección contra el formateo. El más pesado. |

Cada archivo ofuscado se comprueba: las variables globales de los scripts clásicos y los imports/exports de los módulos deben seguir iguales; si no, ese archivo se publica sin ofuscar y con un aviso. Las opciones que cambian el comportamiento (`debugProtection`, `disableConsoleOutput`, `renameGlobals`) nunca se activan solas; pásalas a propósito: `"obfuscate": { "preset": "high", "debugProtection": true }`. Los comentarios de licencia (`/*! … */`, `@license`) se conservan.

## TypeScript

Referencia archivos `.ts` desde tu HTML —o el nombre `.js`, como recomienda TypeScript— y compila. No hace falta instalar nada más.

```html
<script type="module" src="js/main.ts"></script>
```

- Los `.ts`, `.mts` y `.cts` se transpilan con esbuild usando tu `tsconfig.json`. Se quitan los tipos; el nivel de sintaxis se mantiene.
- La salida es `.js` (`.mjs`, `.cjs`) y el HTML se actualiza para apuntar a ella.
- Siguen funcionando: `import './util'`, `import './util.ts'`, `import './util.js'` (cuando el archivo es `util.ts`), `import './componentes'` (carpeta con `index.ts`) y `new URL('./worker.ts', import.meta.url)`.
- Los `.d.ts` y `*.test.ts` no se publican.
- No se comprueban tipos. Para eso, ejecuta `tsc --noEmit` en tu editor o en CI.

## Configuración

Todo funciona sin configuración. Para cambiar valores por defecto, crea `builder.config.json` en la carpeta del proyecto (`npx builder init` crea uno a partir de tu proyecto). Cada opción también se puede pasar por la línea de comandos, que tiene prioridad. Las opciones mal escritas se rechazan con una sugerencia.

```json
{
  "outDir": "dist",
  "obfuscate": "medium",
  "hash": true,
  "compress": true,
  "ignore": ["borradores/**"],
  "js": { "drop": ["console", "debugger"] }
}
```

También se acepta `builder.config.mjs`, que puede exportar un objeto o una función (síncrona o asíncrona) que lo devuelva.

### Todas las opciones

| Opción | Por defecto | Descripción |
| --- | --- | --- |
| `root` | `"."` | Carpeta del proyecto, relativa al archivo de configuración. |
| `outDir` | `"dist"` | Carpeta de salida. Builder se niega a vaciar una carpeta que no creó. |
| `entries` | `"auto"` | `"auto"` usa cada página HTML completa. O una lista de archivos/patrones `.html`, `.js` o `.css`. |
| `include` | `[]` | Patrones que siempre se publican, aunque nada los referencie (ej. `"datos/**"`). |
| `ignore` | `[]` | Patrones que nunca se publican (ej. `"borradores/**"`). |
| `defaultIgnore` | `true` | Excluye secretos (`.env*`, `*.pem`, `*.key`), `node_modules`, `package.json`, lockfiles, configuración de herramientas, tests y `.d.ts`. |
| `unreferenced` | `"process"` | Archivos que nada referencia: `"process"` (minificar y publicar), `"copy"` (publicar tal cual) o `"skip"`. |
| `base` | `"/"` | Ruta pública base del sitio, para URLs absolutas (`"/tienda/"`). |
| `hash` | `false` | Hash del contenido en los nombres de JS/CSS (`assets/app-3f9a1c2b.js`). |
| `sourcemap` | `false` | `true` (archivos `.map` enlazados), `"hidden"` (sin comentario en el código) o `"inline"`. |
| `compress` | `false` | `true` (gzip y brotli), `"gzip"` o `"brotli"`: copias precomprimidas junto a cada archivo. |
| `sri` | `"auto"` | Subresource Integrity. `"auto"` recalcula los atributos `integrity` existentes; `true` además los añade a cada script y hoja de estilos local; `false` los quita. |
| `verify` | `true` | Verificar la salida antes de publicarla. No se recomienda desactivarlo. |
| `clean` | `true` | Reemplazar `outDir` por completo. Con `false`, los archivos nuevos se copian encima de los existentes. |
| `cache` | `true` | Reutilizar resultados de compilaciones anteriores. |
| `workers` | `"auto"` | Hilos para ofuscación y terser: `"auto"`, un número, o `0` para ninguno. |
| `obfuscate` | `false` | `false`, `true` (= `"medium"`), `"low"`, `"medium"`, `"high"`, `"max"`, o un objeto con [opciones de javascript-obfuscator](https://github.com/javascript-obfuscator/javascript-obfuscator#javascript-obfuscator-options) y un `preset` opcional. |
| `dependencies.detect` | `true` | Detectar librerías de terceros automáticamente. |
| `dependencies.include` | `[]` | Patrones que son librerías (no se ofuscan). |
| `dependencies.exclude` | `[]` | Patrones que son tu código (se ofuscan aunque parezcan librería). |
| `dependencies.obfuscate` | `false` | Ofuscar también las librerías. |
| `html.minify` | `true` | Minificar el HTML. |
| `html.removeComments` | `true` | Quitar comentarios HTML. Se conservan los que tienen significado: `<!--! … -->`, condicionales de IE, SSI y ESI. |
| `html.collapseWhitespace` | `"auto"` | Colapsar espacios entre etiquetas. `"auto"` lo desactiva si tu CSS usa `white-space: pre`. |
| `css.minify` | `true` | Minificar el CSS. |
| `css.bundle` | `true` | Incluir los archivos de los `@import`. |
| `css.target` | `"esnext"` | Nivel de sintaxis CSS, ej. `["chrome90", "safari15"]`. |
| `js.minify` | `true` | Minificar el JavaScript. |
| `js.bundle` | `true` | Empaquetar los módulos ES. Con `false`, cada módulo se minifica en su sitio. |
| `js.target` | `"auto"` | `"auto"` mantiene el nivel de sintaxis de tu código; o `"es2018"`, `["chrome90", "safari15"]`… |
| `js.minifier` | `"esbuild"` | `"terser"` añade una segunda pasada de compresión, más fuerte. |
| `js.mergeClassic` | `"auto"` | Unir etiquetas `<script>` clásicas consecutivas cuando es seguro (se desactiva con source maps). |
| `js.drop` | `[]` | Quitar `"console"` y/o `"debugger"`. |
| `js.keepNames` | `false` | Conservar los nombres de funciones y clases (`fn.name`). |
| `js.define` | `{}` | Sustituir identificadores globales al compilar, ej. `{ "DEBUG": "false" }`. |
| `js.legalComments` | `"eof"` | Dónde van los comentarios de licencia: `"eof"`, `"inline"` o `"none"`. |
| `js.chunkDir` | `"assets"` | Carpeta para chunks compartidos, archivos con hash y paquetes vendor. |
| `json.minify` | `true` | Quitar espacios de `.json` y `.webmanifest` (los valores nunca se reescriben). |

## Referencia de la línea de comandos

```text
builder <comando> [carpeta] [opciones]
```

| Comando | Descripción |
| --- | --- |
| `build` | Compila el proyecto en `dist/`. |
| `dev` | Compila, vigila cambios, sirve `dist/` y recarga el navegador. |
| `serve` | Sirve el `dist/` existente. |
| `analyze` | Muestra qué pasaría con cada archivo. No escribe nada. |
| `deps` | Lista qué archivos JavaScript son librerías y cuáles son tuyos. |
| `deps add\|own\|reset <patrón…>` | Marca archivos como librería, como tu código, o vuelve a lo automático. Con `--dir <carpeta>` para otro proyecto. |
| `init` | Crea `builder.config.json` a partir de lo detectado (`--force` para sobrescribir). |
| `help`, `--version` | Ayuda y versión. |

### Opciones de build

| Opción | Descripción |
| --- | --- |
| `--out <carpeta>` | Carpeta de salida (por defecto `dist`). |
| `--config <archivo>` | Archivo de configuración (por defecto `builder.config.json`). |
| `--entry <archivo>` | Punto de entrada explícito. Repetible. |
| `--include <patrón>` / `--ignore <patrón>` | Publicar siempre / no publicar nunca. Repetibles. |
| `--obfuscate [nivel]` | Ofuscar tu JavaScript: `low`, `medium` (por defecto), `high`, `max`. |
| `--dep <patrón>` / `--not-dep <patrón>` | Marcar como librería / como tu código. Repetibles. |
| `--obfuscate-deps` | Ofuscar también las librerías. |
| `--minifier terser` | Pasada extra de compresión con terser. |
| `--compress [gzip\|brotli]` | Escribir archivos `.gz`/`.br` precomprimidos (ambos por defecto). |
| `--hash` | Hash del contenido en los nombres de JS/CSS. |
| `--sourcemap [linked\|hidden\|inline]` | Generar source maps. |
| `--target <target>` | Nivel de JavaScript de salida, ej. `es2018`. |
| `--drop-console` | Quitar `console.*` y `debugger`. |
| `--no-minify` | No minificar (útil para investigar un problema). |
| `--no-merge` | No unir scripts clásicos. |
| `--unreferenced <modo>` | `process`, `copy` o `skip`. |
| `--base <ruta>` | Ruta pública base, ej. `/tienda/`. |
| `--workers <n\|auto>` | Número de hilos (`0` = ninguno). |
| `--no-cache` | Ignorar la caché. |
| `--no-verify` | Saltarse la verificación final (no recomendado). |
| `--force` | Permitir vaciar una carpeta de salida que no creó Builder. |
| `--keep-failed` | Conservar la carpeta temporal si la verificación falla, para revisarla. |
| `--json` | Resultado legible por máquinas. |
| `--verbose` / `--quiet` | Más detalle (notas, archivos copiados y excluidos) / solo errores. |

`dev` y `serve` aceptan además `--port <n>` (por defecto `5173`), `--host <host>` (por defecto `127.0.0.1`) y `--open`.

## Garantías de seguridad

| Riesgo habitual de una herramienta de compilación | Qué hace vanilla-builder |
| --- | --- |
| Unir scripts clásicos rompe las globales compartidas | Solo une scripts consecutivos con el mismo `defer` y modo estricto, sin `document.currentScript` ni `let`/`const` en conflicto, con un separador seguro. |
| La minificación renombra o añade globales | Compara las globales antes y después; si cambian, usa una minificación más segura o deja el original. |
| La ofuscación rompe un módulo | Compara imports, exports y atributos de import tras ofuscar; si no coinciden, ese archivo se publica sin ofuscar. |
| Minificar el HTML cambia el texto | Comparación estructural de elementos, atributos y texto; `<pre>`, `<textarea>` y plantillas intactos. |
| Atributos `integrity` obsoletos bloquean scripts | Se recalculan siempre que cambia el contenido. |
| Codificaciones antiguas o BOM se corrompen | Los bytes del HTML se conservan; JS y CSS se emiten con escapes ASCII. |
| Los números del JSON pierden precisión | Solo se quitan espacios fuera de las cadenas. |
| Borrar la carpeta equivocada | Nunca vacía una carpeta que no creó (marcada con `.builder-manifest.json`), ni la del proyecto, ni tu carpeta de usuario, ni la raíz de una unidad. |
| Una compilación fallida deja el sitio roto | La salida se escribe y verifica en una carpeta temporal antes de reemplazar `dist/`. |
| Publicar secretos | `.env*`, claves, `node_modules`, `package.json` y configuración de herramientas se excluyen por defecto. |

Cada versión se prueba abriendo sitios de ejemplo —original y compilado— en un Chromium real y exigiendo el mismo comportamiento, sin errores de consola ni 404, en cinco variantes (por defecto, ofuscación alta + hash, ofuscación máxima, terser + precompresión, sin minificar), compilando con Node 16 y con el Node actual.

## Rendimiento

Medido con `npm run bench` sobre un sitio generado con 40 páginas, 240 módulos, 120 scripts clásicos, 30 CSS y 200 imágenes (mediana de 3 ejecuciones; Intel i7-11700F, Node 24, Windows):

| Compilación | Primera vez | Recompilar (caché) | v0.1.0 |
| --- | ---: | ---: | ---: |
| Por defecto | 1,9 s | 1,4 s | 3,7 s |
| `--obfuscate` | 7,0 s | 1,8 s | 11,5–17,9 s |
| `--hash --compress` | 2,1 s | 1,1 s | 2,6–3,8 s |
| `--minifier terser` | 3,7 s | 1,6 s | 5,6–6,0 s |

- **Hilos.** La ofuscación, terser y la comprobación final de sintaxis van en hilos de trabajo (`"auto"` ≈ núcleos físicos, hasta 8). Los hilos solo arrancan cuando hay trabajo suficiente para compensar su arranque, así que un proyecto pequeño no va más lento.
- **Caché persistente.** Los resultados lentos se guardan por contenido en `node_modules/.cache/vanilla-builder` (o en el temporal del sistema). La misma entrada, opciones y versiones dan la misma salida byte a byte; las pruebas lo comprueban. Cambia la ubicación con `BUILDER_CACHE_DIR`; desactívala con `--no-cache`.
- **Determinista.** Los archivos independientes se procesan en paralelo pero se registran en su orden original, así que la salida nunca depende de los tiempos.
- Para ver dónde se va el tiempo en tu proyecto, mira `perf.phases` en `--json`.

## API de JavaScript

```js
import { build, analyze } from 'vanilla-builder';

const result = await build({
  dir: 'mi-sitio',                      // carpeta del proyecto (por defecto, la actual)
  overrides: { obfuscate: 'high' },     // misma forma que builder.config.json
});

console.log(result.report.totals);      // { before, size, gzip, brotli, files }
console.log(result.warnings);           // string[]
console.log(result.dependencies);       // [{ rel, reason }]
```

- `build(opciones)` compila y escribe `outDir`. Opciones: `dir`, `config` (ruta a un archivo de configuración), `overrides`, `force`, `keepFailed`, `log` (función que recibe los mensajes de progreso).
- `analyze(opciones)` devuelve el mismo resultado sin escribir nada.
- Los errores se lanzan como `BuildError` (exportado), con una lista `details`.
- `startServer({ dir, port, host })` sirve una carpeta, como `builder serve`.

## Solución de problemas

### `La carpeta de salida … ya tiene archivos y no la creó Builder`

Builder nunca vacía una carpeta que no creó. Elige otra con `--out`, vacíala tú o usa `--force` si estás seguro.

### `Falta el paquete opcional "javascript-obfuscator"` (o `"terser"`)

Instálalo en tu proyecto: `npm install --save-dev javascript-obfuscator`. Es opcional para que la instalación base sea pequeña.

### Falta un archivo en `dist/`

Ejecuta `npx builder analyze --verbose`. Lista cada archivo con su destino, y cada archivo excluido con el motivo. Los que se excluyen por defecto (secretos, configuración, tests) se pueden publicar igualmente con `--include "<patrón>"`.

### Se ofuscó una librería, o no se ofuscó mi código

Ejecuta `npx builder deps` para ver el motivo de cada archivo y corrígelo con `data-builder`, un comentario `@builder-*` o `npx builder deps add|own` ([detalles](#comprobar-y-corregir-la-detección)).

### `Dos resultados distintos quieren escribirse en …`

Dos salidas acabarían en la misma ruta. Suele pasar si una carpeta de tu proyecto se llama igual que `js.chunkDir` (`assets` por defecto), o si el mismo módulo se usa con import maps distintos. Cambia `js.chunkDir` a otro nombre.

### `"base" debe empezar con "/"` al usar Git Bash en Windows

Git Bash convierte los argumentos que parecen rutas de Unix, así que `--base /tienda/` llega como `C:/Program Files/Git/tienda/`. Pon `"base": "/tienda/"` en `builder.config.json`, o ejecuta `MSYS_NO_PATHCONV=1 npx builder build --base /tienda/`. PowerShell y cmd no tienen este problema.

### Algo se comporta distinto tras compilar

Compila con `--no-minify` para descartar la minificación, o sin `--obfuscate` para descartar la ofuscación. Si encuentras una diferencia, [abre un issue](https://github.com/MarioACo/vanilla-builder/issues) con el ejemplo más pequeño que puedas compartir.

## Limitaciones conocidas

- Ningún ofuscador hace el código imposible de leer; solo lo hace mucho más caro de entender.
- Con `hash`, JS y CSS cambian de nombre. Si tu código pide alguno con una ruta escrita como texto, también se publica la ruta original y recibes un aviso.
- Colapsar espacios del HTML cambia `textContent`, pero no lo que se ve. Para conservar el texto byte a byte: `"html": { "collapseWhitespace": false }`.
- Un `import()` con ruta totalmente calculada hace que ese grupo de módulos se minifique archivo por archivo en vez de empaquetarse, para que las rutas sigan funcionando.
- TypeScript: no se comprueban tipos, no hay `.tsx`/JSX, y los source maps apuntan al JavaScript ya sin tipos.

## Contribuir

Los issues y pull requests son bienvenidos.

```bash
git clone https://github.com/MarioACo/vanilla-builder.git
cd vanilla-builder
npm install
npm test               # pruebas unitarias y de integración (Node 18+; en Node 16: npm run test:node16)
npm run test:browser   # sitios originales frente a compilados en Chromium (usa Chrome/Edge o BUILDER_CHROMIUM)
npm run bench          # rendimiento sobre un sitio generado
```

## Licencia

[MIT](LICENSE) © MarioACo
