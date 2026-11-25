# Inventario de Producción

App web para controlar materia prima, envases y producción (envasado) con trazabilidad por lote.
Node.js + PostgreSQL, lista para Dokploy.

## Lógica del sistema

### Flujo
1. **Recepción** (recepcionista): entra materia prima (MP) y envases (ENV) comprados. Cada recepción recibe un número `REC-000001`.
2. **Preparación** (químico): con la materia prima prepara un **producto preparado** (PP, a granel) siguiendo su fórmula. Registra lo planificado y lo obtenido (rendimiento). Aquí nace el **lote = fecha de elaboración** (`AAAAMMDD`; si ese día hay otra preparación del mismo producto: `-2`, `-3`…).
3. **Envasado** (envasador): elige un **lote** de producto preparado y lo envasa con los envases. El producto terminado (PT) **hereda el mismo lote**.

### Catálogo
| Tipo | Código automático | Datos clave |
|---|---|---|
| Materia prima | `MP-0001` | unidad, stock mínimo |
| Envase / empaque | `ENV-0001` | tipo (botella, galón, tapa, etiqueta, caja…), capacidad |
| Producto preparado | `PP-0001` | nombre + **marca**, fórmula de MP por unidad |
| Producto terminado | `PT-0001` | producto preparado + presentación + **envases que lleva**; el nombre se arma solo (producto + marca + presentación) |

Los códigos los asigna el sistema, son correlativos por tipo, no se repiten y no se editan. Tampoco se permiten dos artículos con el mismo nombre (y marca) en el mismo tipo.

### Control
- El stock nunca se edita: todo es un movimiento en el kardex, por lote.
- Consumo teórico = fórmula × cantidad × (1 + merma). El usuario registra el real; desviaciones o rendimientos fuera de la tolerancia (5% por defecto) exigen observación.
- Si falta stock de cualquier componente, no se registra nada.
- Costo real por lote, arrastrado de la MP a la preparación y de ahí al envasado.
- Anulaciones solo por el administrador; se bloquean si lo producido ya se usó (p. ej. una preparación ya envasada).

### Perfiles
| | Admin | Recepcionista | Químico | Envasador |
|---|---|---|---|---|
| Recepción de MP y envases | ✓ | ✓ | | |
| Crear MP / envases | ✓ | ✓ | | |
| Productos preparados, marcas, fórmulas | ✓ | | ✓ | |
| Registrar preparación | ✓ | | ✓ | |
| Registrar envasado | ✓ | | | ✓ |
| Productos terminados (presentaciones) | ✓ | | | |
| Salidas, conteo físico, anulaciones, reportes, usuarios | ✓ | | | |
| Consultar inventario, preparaciones y envasados | ✓ | ✓ | ✓ | ✓ |

## Despliegue en Dokploy (sin dominio)

### 1. Base de datos
1. En tu proyecto de Dokploy: **Create Service → Database → PostgreSQL**.
2. Nombre `inventario-db`, base `inventario`, usuario `inventario` y una contraseña fuerte. **Deploy**.
3. Copia la **Internal Connection URL** (algo como `postgresql://inventario:...@inventario-db-xxxx:5432/inventario`).
4. En la pestaña **Backups** de la base, programa un respaldo diario (recomendado).

### 2. Aplicación
1. **Create Service → Application**, nombre `inventario-app`.
2. **Source:**
   - **Drop:** sube el `.zip` de este proyecto, o
   - **GitHub/Git:** sube esta carpeta a un repositorio y conéctalo (así cada `git push` redespliega).
3. **Build Type:** `Dockerfile` (ruta `Dockerfile`).
4. **Environment:** pega las variables de `.env.example` con tus valores. `DATABASE_URL` = la URL interna del paso 1. Genera `SESSION_SECRET` con `openssl rand -hex 32`.
5. **Deploy**. En los logs verás `administrador inicial creado`.

### 3. Acceso web sin dominio
En la app: **Domains → Generate Domain → traefik.me**, puerto **3000**, sin HTTPS.
Obtendrás una dirección como `http://inventario-app-abc123.203.0.113.10.traefik.me` que funciona desde cualquier navegador.

> traefik.me solo ofrece HTTP. Para una red interna o pruebas está bien; si la app se usará desde internet abierto, compra un dominio (~US$10/año), apúntalo a la IP del servidor, actívale HTTPS en Dokploy y cambia `COOKIE_SECURE=true`.

### 4. Primeros pasos en la app
1. Entra con `ADMIN_USER` / `ADMIN_PASSWORD`.
2. **Usuarios:** crea recepcionista(s), químico(s) y envasador(es).
3. **Artículos:** materias primas y envases.
4. **Artículos → Producto preparado** (con marca) y su **fórmula**.
5. **Productos terminados:** presentación y envases de cada uno.
6. **Recepción → Carga de inventario inicial:** existencias actuales.

## Desarrollo local
```bash
npm install
DATABASE_URL=postgres://... ADMIN_PASSWORD=... node src/server.js
```
Las tablas se crean automáticamente al arrancar (`src/migrations`).
