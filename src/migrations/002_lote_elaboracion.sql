-- El lote del producto terminado = fecha de elaboración del producto que se envasa.
-- Varios envasados del mismo granel comparten el mismo lote.
ALTER TABLE productions ADD COLUMN elaboration_date DATE;
ALTER TABLE productions ADD COLUMN lot_code TEXT;
UPDATE productions SET elaboration_date = production_date, lot_code = to_char(production_date, 'YYYYMMDD') WHERE lot_code IS NULL;
ALTER TABLE productions ALTER COLUMN elaboration_date SET NOT NULL;
ALTER TABLE productions ALTER COLUMN lot_code SET NOT NULL;
CREATE INDEX productions_lot_idx ON productions(product_id, lot_code);
