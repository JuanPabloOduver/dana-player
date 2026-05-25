# Dana Player v3 — Electron + danaplayd

Reproductor de escritorio para el códec lossless `.dana`.  
Arquitectura inspirada en **MPD** (Music Player Daemon): el demonio `danaplayd` posee y ejecuta la reproducción de audio por completo; la interfaz Electron solo envía comandos de texto y lee el estado vía polling.

---

## Estructura del proyecto

```
dana-electron/
├── package.json
├── daemon/
│   └── Danaplayerd.java        ← Demonio decodificador + servidor Unix Socket
└── src/
    ├── main/
    │   └── main.js             ← Proceso Electron: cliente socket, polling, cover art
    ├── preload/
    │   └── preload.js          ← Context Bridge seguro hacia el renderer
    └── renderer/
        ├── index.html          ← UI: cover, progreso, volumen, letras, controles
        ├── styles.css
        └── renderer.js         ← Lógica de UI (sin Web Audio API)
```

---

## Requisitos

- Node.js 18+ y npm
- Java 17+ (para el demonio)
- Electron 29

---

## Instalación

```bash
cd dana-electron
npm install
```

---

## Ejecución

### 1. Compilar y arrancar el demonio

```bash
cd daemon
javac Danaplayerd.java
java com.dana.daemon.Danaplayerd
```

El demonio queda escuchando en `/tmp/danaplayd.sock`.

### 2. Arrancar la UI Electron

```bash
npm start
```

---

## Protocolo IPC (Unix Domain Socket)

### Modelo de comunicación

Cada comando abre una conexión nueva, escribe `<comando>\n` y espera la respuesta.  
El demonio responde y **cierra la conexión** al terminar.  
No hay conexión persistente ni flujo continuo de bytes.

```
Cliente                      danaplayd
  │── "play /ruta/song.dana\n" ──▶ │
  │◀── "OK\n" ──────────────────── │ (conexión cerrada)

  │── "get_data\n" ──────────────▶ │
  │◀── "{...JSON...}" ───────────── │ (conexión cerrada)

  │── "get_cover\n" ─────────────▶ │
  │◀── [bytes binarios de imagen] ─ │ (conexión cerrada)
```

### Comandos

| Comando | Respuesta |
|---------|-----------|
| `play <ruta_absoluta>` | `OK` |
| `pause` | `OK` |
| `stop` | `OK` |
| `set_vol <0-200>` | `OK` |
| `get_data` | JSON (DanaTags) |
| `get_cover` | Bytes crudos de imagen (JPEG/PNG) |

### DanaTags — campos JSON de `get_data`

| Campo | Tipo | Descripción |
|-------|------|-------------|
| `state` | string | `"PLAYING"` \| `"PAUSED"` \| `"STOPPED"` |
| `title` | string | Título del track |
| `artist` | string | Artista |
| `album` | string | Álbum |
| `time` | number | Tiempo transcurrido (segundos) |
| `duration` | number | Duración total (segundos) |
| `has_cover` | boolean | `true` si hay carátula disponible |
| `lyrics` | string | Letras completas (saltos de línea como `\n`) |
| `sample_rate` | number | Hz (ej. 44100) |
| `bit_depth` | number | Bits (ej. 16) |
| `channels` | number | 1 = mono, 2 = estéreo |

---

## Cómo funciona el polling

`main.js` ejecuta `get_data` cada **1 segundo** mediante `setInterval`.  
La respuesta JSON actualiza título, artista, álbum, progreso, estado y letras en la UI.

```js
// Fragmento ilustrativo de main.js
setInterval(async () => {
    const raw  = await daemonRequest('get_data');
    const tags = JSON.parse(raw);
    sendToWindow('dana-tags', tags);
}, 1000);
```

---

## Cómo funciona la carátula (Cover Art)

La carátula **no** se pide en cada tick de polling para evitar transferencias innecesarias.  
El proceso es:

1. Cada tick, `get_data` devuelve `has_cover: true/false` y la ruta del archivo actual.
2. Solo cuando `has_cover === true` **y** la ruta cambió (track nuevo), se llama a `get_cover`.
3. `get_cover` devuelve los bytes crudos de la imagen.
4. `main.js` los convierte a una data-URL base64 y la envía al renderer.
5. El renderer la asigna a `<img src>` directamente.

---

## Conectar el codec .dana

Ver la sección correspondiente en `daemon/Danaplayerd.java`.  
El único punto de integración está marcado con `// [CODEC]` en `startProducer()`:

```java
// Cambiar esta línea por la implementación real:
decoder = new StubDecoder();
```

Implementar la interfaz `DanaDecoder` con las clases del codec lossless y asignarla ahí.

---

## Atajos de teclado

| Tecla | Acción |
|-------|--------|
| `Space` | Play / Pause |
| `→` | Siguiente track |
| `←` | Track anterior |
| `L` | Activar/desactivar loop |

---

## Variable de entorno

| Variable | Default | Descripción |
|----------|---------|-------------|
| `DANA_SOCK` | `/tmp/danaplayd.sock` | Ruta del Unix Domain Socket |

---

## Empaquetar distribución

```bash
npm run dist
```
