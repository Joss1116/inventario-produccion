-- =====================================================================
-- Inventario de Producción — esquema inicial
-- Principio: el stock NUNCA se guarda como un número editable.
-- Todo cambio es un MOVIMIENTO (kardex) ligado a un LOTE.
-- Stock de lote = SUM(movimientos.qty) del lote.
-- =====================================================================

CREATE TABLE users (
  id            SERIAL PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE,
  full_name     TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('admin','operador')),
  active        BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- MP = materia prima, ENV = envase/empaque (botella, tapa, etiqueta, caja), PT = producto terminado
CREATE TABLE items (
  id         SERIAL PRIMARY KEY,
  code       TEXT NOT NULL UNIQUE,
  name       TEXT NOT NULL,
  type       TEXT NOT NULL CHECK (type IN ('MP','ENV','PT')),
  unit       TEXT NOT NULL,              -- kg, g, L, ml, und
  min_stock  NUMERIC(14,4) NOT NULL DEFAULT 0,
  active     BOOLEAN NOT NULL DEFAULT TRUE,
  notes      TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE suppliers (
  id      SERIAL PRIMARY KEY,
  name    TEXT NOT NULL UNIQUE,
  contact TEXT
);

CREATE TABLE purchases (
  id            SERIAL PRIMARY KEY,
  doc_number    TEXT,                    -- factura / conduce
  supplier_id   INT REFERENCES suppliers(id),
  purchase_date DATE NOT NULL,
  notes         TEXT,
  is_initial    BOOLEAN NOT NULL DEFAULT FALSE,
  status        TEXT NOT NULL DEFAULT 'activa' CHECK (status IN ('activa','anulada')),
  created_by    INT NOT NULL REFERENCES users(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  annulled_by   INT REFERENCES users(id),
  annulled_at   TIMESTAMPTZ,
  annul_reason  TEXT
);

-- Fórmula / lista de materiales (BOM): consumo estándar por 1 unidad de PT
CREATE TABLE recipe_lines (
  id            SERIAL PRIMARY KEY,
  product_id    INT NOT NULL REFERENCES items(id),
  component_id  INT NOT NULL REFERENCES items(id),
  qty_per_unit  NUMERIC(14,6) NOT NULL CHECK (qty_per_unit > 0),
  waste_pct     NUMERIC(6,3)  NOT NULL DEFAULT 0 CHECK (waste_pct >= 0 AND waste_pct < 100),
  UNIQUE (product_id, component_id),
  CHECK (product_id <> component_id)
);

CREATE TABLE productions (
  id              SERIAL PRIMARY KEY,
  code            TEXT NOT NULL UNIQUE,  -- lote de producción, p.ej. P-20261124-003
  product_id      INT NOT NULL REFERENCES items(id),
  qty_good        NUMERIC(14,4) NOT NULL CHECK (qty_good >= 0),
  qty_rejected    NUMERIC(14,4) NOT NULL DEFAULT 0 CHECK (qty_rejected >= 0),
  production_date DATE NOT NULL,
  shift           TEXT,
  line            TEXT,
  expiry_date     DATE,
  notes           TEXT,
  total_cost      NUMERIC(16,4) NOT NULL DEFAULT 0,
  status          TEXT NOT NULL DEFAULT 'registrada' CHECK (status IN ('registrada','anulada')),
  created_by      INT NOT NULL REFERENCES users(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  annulled_by     INT REFERENCES users(id),
  annulled_at     TIMESTAMPTZ,
  annul_reason    TEXT,
  CHECK (qty_good + qty_rejected > 0)
);

CREATE TABLE production_consumptions (
  id             SERIAL PRIMARY KEY,
  production_id  INT NOT NULL REFERENCES productions(id),
  component_id   INT NOT NULL REFERENCES items(id),
  theoretical_qty NUMERIC(14,4) NOT NULL,
  actual_qty     NUMERIC(14,4) NOT NULL CHECK (actual_qty >= 0),
  cost           NUMERIC(16,4) NOT NULL DEFAULT 0,
  UNIQUE (production_id, component_id)
);

-- Salidas / despachos (PT a almacén o ventas, devoluciones a proveedor, etc.)
CREATE TABLE dispatches (
  id          SERIAL PRIMARY KEY,
  item_id     INT NOT NULL REFERENCES items(id),
  qty         NUMERIC(14,4) NOT NULL CHECK (qty > 0),
  destination TEXT,
  doc_number  TEXT,
  notes       TEXT,
  created_by  INT NOT NULL REFERENCES users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Ajustes por conteo físico
CREATE TABLE adjustments (
  id          SERIAL PRIMARY KEY,
  item_id     INT NOT NULL REFERENCES items(id),
  system_qty  NUMERIC(14,4) NOT NULL,
  counted_qty NUMERIC(14,4) NOT NULL CHECK (counted_qty >= 0),
  reason      TEXT NOT NULL,
  created_by  INT NOT NULL REFERENCES users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE lots (
  id            SERIAL PRIMARY KEY,
  item_id       INT NOT NULL REFERENCES items(id),
  lot_code      TEXT NOT NULL,
  source        TEXT NOT NULL CHECK (source IN ('COMPRA','PRODUCCION','AJUSTE','INICIAL')),
  purchase_id   INT REFERENCES purchases(id),
  production_id INT REFERENCES productions(id),
  received_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  expiry_date   DATE,
  unit_cost     NUMERIC(16,6) NOT NULL DEFAULT 0,
  initial_qty   NUMERIC(14,4) NOT NULL
);
CREATE INDEX lots_item_idx ON lots(item_id);

CREATE TABLE movements (
  id         BIGSERIAL PRIMARY KEY,
  item_id    INT NOT NULL REFERENCES items(id),
  lot_id     INT NOT NULL REFERENCES lots(id),
  mtype      TEXT NOT NULL CHECK (mtype IN
              ('COMPRA','INICIAL','CONSUMO','PRODUCCION','SALIDA','AJUSTE','ANULACION')),
  qty        NUMERIC(14,4) NOT NULL CHECK (qty <> 0),   -- + entra, - sale
  unit_cost  NUMERIC(16,6) NOT NULL DEFAULT 0,
  ref_type   TEXT,      -- purchase | production | dispatch | adjustment
  ref_id     INT,
  notes      TEXT,
  user_id    INT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX movements_item_idx ON movements(item_id, created_at);
CREATE INDEX movements_lot_idx  ON movements(lot_id);
CREATE INDEX movements_ref_idx  ON movements(ref_type, ref_id);

CREATE VIEW v_lot_stock AS
SELECT l.*, COALESCE(SUM(m.qty),0)::NUMERIC(14,4) AS qty
FROM lots l LEFT JOIN movements m ON m.lot_id = l.id
GROUP BY l.id;

CREATE VIEW v_item_stock AS
SELECT i.*,
       COALESCE(s.qty,0)::NUMERIC(14,4)   AS stock,
       COALESCE(s.value,0)::NUMERIC(16,2) AS stock_value
FROM items i
LEFT JOIN (
  SELECT item_id, SUM(qty) AS qty, SUM(qty*unit_cost) AS value
  FROM v_lot_stock GROUP BY item_id
) s ON s.item_id = i.id;
