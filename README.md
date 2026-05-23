# Dana Player 🎵

Reproductor web para el códec lossless `.dana`. Backend en Spring Boot con patrón Productor-Consumidor + Ring Buffer. Frontend en Vanilla JS con Web Audio API para gapless playback.

---

## Requisitos

- Java 17+
- Maven 3.8+

---

## Estructura del proyecto

```
dana-player/
├── pom.xml
└── src/main/
    ├── java/com/dana/player/
    │   ├── DanaPlayerApplication.java
    │   ├── buffer/
    │   │   ├── CircularBuffer.java       ← Ring buffer thread-safe
    │   │   ├── CodecProducer.java        ← Hilo productor (codec → buffer)
    │   │   └── WebSocketConsumer.java    ← Hilo consumidor (buffer → WS)
    │   ├── codec/
    │   │   ├── DanaDecoder.java          ← INTERFAZ del códec (conecta aquí)
    │   │   └── StubDanaDecoder.java      ← Implementación stub para pruebas
    │   ├── config/
    │   │   └── WebSocketConfig.java
    │   ├── controller/
    │   │   └── FileSystemController.java ← GET /api/tracks, GET /api/info
    │   ├── model/
    │   │   └── DanaTrack.java
    │   ├── service/
    │   │   └── FileSystemService.java
    │   └── websocket/
    │       ├── AudioStreamHandler.java   ← Handler WS /audio-stream
    │       └── StreamingSession.java
    └── resources/
        ├── application.properties
        └── static/
            ├── index.html
            ├── styles.css
            └── app.js
```

---

## Configuración

En `src/main/resources/application.properties`:

```properties
# Carpeta con los archivos .dana
dana.music.folder=./music

# Capacidad del buffer circular (número de chunks)
dana.buffer.capacity=32

# Tamaño de cada chunk en bytes (4096 ≈ 23ms de audio a 44.1kHz/16bit/stereo)
dana.buffer.chunk-size=4096
```

---

## Cómo conectar tu códec real

1. Abre `StubDanaDecoder.java` — úsalo como referencia.
2. Crea una clase que implemente la interfaz `DanaDecoder`:

```java
@Component
public class MiDanaDecoder implements DanaDecoder {

    @Override
    public void open(String filePath) throws IOException {
        // Instancia tus ~8 clases del códec aquí
        // Abre el archivo .dana
    }

    @Override
    public byte[] readNextChunk(int chunkSize) throws IOException {
        // Llama a tu códec para decodificar el siguiente bloque PCM
        // Devuelve los bytes crudos (PCM 16-bit LE, 44100Hz, 2ch)
    }

    @Override
    public boolean hasMore() {
        // return true mientras haya datos por decodificar
    }

    @Override
    public void close() throws IOException {
        // Libera recursos
    }

    @Override public int getSampleRate() { return 44100; }
    @Override public int getChannels()   { return 2; }
    @Override public int getBitDepth()   { return 16; }
}
```

3. En `AudioStreamHandler.java`, reemplaza la línea:

```java
// ANTES (stub):
DanaDecoder decoder = new StubDanaDecoder();

// DESPUÉS (inyección del bean real):
// Inyecta MiDanaDecoder via constructor o campo @Autowired
// IMPORTANTE: cada stream necesita su propia instancia (no singleton)
// Usa un @Prototype scope o una factory.
```

### Ejemplo con factory para múltiples instancias:

```java
// En MiDanaDecoder.java:
@Component
@Scope("prototype")
public class MiDanaDecoder implements DanaDecoder { ... }

// En AudioStreamHandler.java:
@Autowired
private ApplicationContext ctx;

// Al crear el stream:
DanaDecoder decoder = ctx.getBean(MiDanaDecoder.class);
```

---

## Ejecutar

```bash
# Crear la carpeta de música (si no existe)
mkdir -p music

# Copiar tus archivos .dana a ./music/
cp mis-canciones/*.dana music/

# Compilar y ejecutar
mvn spring-boot:run

# Abrir en el navegador
open http://localhost:8080
```

---

## Protocolo WebSocket

**Cliente → Servidor** (mensajes de texto):

| Mensaje | Descripción |
|---------|-------------|
| `PLAY:<trackId>` | Inicia el stream del track |
| `STOP` | Detiene el stream actual |

**Servidor → Cliente:**

| Mensaje | Descripción |
|---------|-------------|
| `PLAYING:<trackId>` | Confirmación de inicio |
| `TRACK_END:<trackId>` | El track terminó de reproducirse |
| `ERROR:<mensaje>` | Error en el servidor |
| `[bytes binarios]` | Chunk de audio PCM crudo |

---

## Formato de audio

- **Codificación:** PCM crudo (sin cabecera WAV ni contenedor)
- **Sample rate:** 44100 Hz
- **Canales:** 2 (estéreo)
- **Bit depth:** 16-bit signed, little-endian

Si tu códec produce un formato diferente, ajusta las constantes en `app.js`:

```js
const SAMPLE_RATE  = 44100;  // Hz
const NUM_CHANNELS = 2;      // 1 = mono, 2 = stereo
const BIT_DEPTH    = 16;     // bits por muestra
```

Y actualiza `pcmToAudioBuffer()` si el endianness o la profundidad de bits cambian.

---

## Atajos de teclado

| Tecla | Acción |
|-------|--------|
| `Space` | Play / Pause |
| `→` | Siguiente track |
| `←` | Track anterior |
| `L` | Activar/desactivar loop |
