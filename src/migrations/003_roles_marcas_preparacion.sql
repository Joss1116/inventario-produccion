-- =====================================================================
-- v2: flujo en dos etapas
--   Recepcionista -> entra MP y envases
--   Químico       -> PREPARACIÓN: MP  => Producto preparado (PP, a granel), crea el lote (= fecha de elaboración)
--   Envasador     -> ENVASADO:    PP (de un lote) + envases => Producto terminado (PT)
-- =====================================================================

-- Roles
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
UPDATE users SET role = 'envasador' WHERE role = 'operador';
ALTER TABLE users ADD CONSTRAINT users_role_check
  CHECK (role IN ('admin','recepcionista','quimico','envasador'));

-- Marcas
CREATE TABLE brands (
  id         SERIAL PRIMARY KEY,
  name       TEXT NOT NULL,
  active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX brands_name_uq ON brands (lower(name));

-- Artículos: nuevo tipo PP (producto preparado) + atributos
ALTER TABLE items DROP CONSTRAINT IF EXISTS items_type_check;
ALTER TABLE items ADD CONSTRAINT items_type_check CHECK (type IN ('MP','ENV','PP','PT'));
ALTER TABLE items
  ADD COLUMN brand_id       INT REFERENCES brands(id),     -- PP
  ADD COLUMN packaging_type TEXT,                          -- ENV: Botella, Tapa, Etiqueta...
  ADD COLUMN capacity       NUMERIC(14,4),                 -- ENV: capacidad del envase
  ADD COLUMN capacity_unit  TEXT,
  ADD COLUMN bulk_id        INT REFERENCES items(id),      -- PT: producto preparado que contiene
  ADD COLUMN presentation   TEXT;                          -- PT: "Galón", "1 L", "500 ml"...

-- Evita artículos duplicados (mismo tipo + nombre + marca)
CREATE UNIQUE INDEX items_name_uq ON items (type, lower(name), COALESCE(brand_id, 0));

-- Contadores para códigos automáticos (MP-0001, ENV-0001, PP-0001, PT-0001, REC-000001)
CREATE TABLE code_counters (
  prefix TEXT PRIMARY KEY,
  last   INT  NOT NULL DEFAULT 0
);
INSERT INTO code_counters(prefix, last)
SELECT p, COALESCE((
  SELECT MAX(substring(code FROM '^' || p || '-(\d+)$')::int) FROM items WHERE code ~ ('^' || p || '-\d+$')
), 0)
FROM unnest(ARRAY['MP','ENV','PP','PT']) AS p;
INSERT INTO code_counters(prefix, last) SELECT 'REC', COALESCE(MAX(id),0) FROM purchases;

-- Recepciones con número propio
ALTER TABLE purchases ADD COLUMN code TEXT;
UPDATE purchases SET code = 'REC-' || lpad(id::text, 6, '0') WHERE code IS NULL;
ALTER TABLE purchases ALTER COLUMN code SET NOT NULL;
CREATE UNIQUE INDEX purchases_code_uq ON purchases(code);

-- Producciones: ahora son de dos clases
ALTER TABLE productions
  ADD COLUMN kind        TEXT NOT NULL DEFAULT 'ENVASADO' CHECK (kind IN ('PREPARACION','ENVASADO')),
  ADD COLUMN planned_qty NUMERIC(14,4),               -- PREPARACION: cantidad que se planificó preparar
  ADD COLUMN bulk_lot_id INT REFERENCES lots(id);     -- ENVASADO: lote de producto preparado usado
CREATE INDEX productions_kind_idx ON productions(kind, production_date);

-- La vista se recrea para incluir las columnas nuevas de items
DROP VIEW v_item_stock;
CREATE VIEW v_item_stock AS
SELECT i.*,
       COALESCE(s.qty,0)::NUMERIC(14,4)   AS stock,
       COALESCE(s.value,0)::NUMERIC(16,2) AS stock_value
FROM items i
LEFT JOIN (
  SELECT item_id, SUM(qty) AS qty, SUM(qty*unit_cost) AS value
  FROM v_lot_stock GROUP BY item_id
) s ON s.item_id = i.id;
