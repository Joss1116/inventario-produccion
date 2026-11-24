# Inventario de Producción

App web para controlar materia prima, envases y producción (envasado) con trazabilidad por lote.
Node.js + PostgreSQL, lista para Dokploy.

## Lógica del sistema

| Concepto | Cómo funciona |
|---|---|
| **Artículos** | Tres tipos: Materia prima (MP), Envase/empaque (ENV), Producto terminado (PT). Cada uno con unidad base y stock mínimo. |
| **Kardex** | El stock nunca se edita a mano: cada cambio es un movimiento (compra, consumo, producción, salida, ajuste, anulación). Stock = suma de movimientos. |
| **Lotes** | Cada entrada crea un lote con costo (y vencimiento opcional para materias primas). Las salidas descuentan en orden **FEFO/FIFO** (primero lo que vence o entró antes). |
| **Fórmula (BOM)** | Consumo estándar por 1 unidad de PT + % de merma aceptada. |
| **Producción** | El lote del producto terminado es la **fecha de elaboración** del producto que se envasa (formato AAAAMMDD, sin vencimiento); varios envasados del mismo granel comparten lote. El operador registra unidades buenas y rechazadas. El sistema calcula el consumo teórico = fórmula × (buenas + rechazadas) × (1 + merma). El operador corrige el consumo real si fue distinto. Si la desviación supera la tolerancia (5% por defecto), debe escribir una observación. Todo ocurre en una transacción: si falta stock de cualquier componente, no se registra nada. |
| **Costo** | El costo de cada producción sale de los lotes realmente consumidos. Costo unitario del PT = costo de materiales / unidades buenas. |
| **Anulaciones** | Solo el admin las hace, con motivo. Devuelven los materiales a sus lotes de origen. Se bloquean si lo producido o comprado ya se usó. |
| **Conteo físico** | El admin registra lo contado; el sistema genera el ajuste por la diferencia. |
| **Capacidad** | Para cada PT: cuántas unidades se pueden producir con el stock actual y qué componente es el cuello de botella. |

### Roles
- **Operador:** registra producción y consulta inventario, producciones y kardex.
- **Administrador:** todo lo anterior + artículos, fórmulas, compras/entradas (incluido inventario inicial), salidas, conteos, anulaciones, reportes y usuarios.

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
1. Entra con `ADMIN_USER` / `ADMIN_PASSWORD` y cambia la contraseña en **Usuarios**.
2. **Artículos:** crea materias primas, envases y productos terminados.
3. **Fórmulas:** define el consumo por unidad de cada producto.
4. **Compras / entradas → Inventario inicial:** carga las existencias actuales.
5. **Usuarios:** crea a los operadores.

## Desarrollo local
```bash
npm install
DATABASE_URL=postgres://... ADMIN_PASSWORD=... node src/server.js
```
Las tablas se crean automáticamente al arrancar (`src/migrations`).
