-- Third review (operations, security, schema).

-- recentRejections() counts the moenergy:* rows of the last hour.
CREATE INDEX quarantine_moenergy_idx ON quarantine (created_at) WHERE rule_code LIKE 'moenergy:%';

-- Each reading is inserted and then updated once or twice (ledger_status), so dead rows pile up quickly;
-- clean the table before it grows instead of after 20% of it is dead.
ALTER TABLE readings SET (
  autovacuum_vacuum_scale_factor = 0.02,
  autovacuum_vacuum_insert_scale_factor = 0.05,
  autovacuum_analyze_scale_factor = 0.02
);

-- The payload guard compared up to 20 MB of body on every update, even a parse_status update that cannot change it.
DROP TRIGGER raw_uploads_payload_guard ON raw_uploads;
CREATE TRIGGER raw_uploads_payload_guard
  BEFORE UPDATE OF station_id, arrived_at, method, path, query, headers, content_type, body_bytes, body_raw, body_json
  ON raw_uploads FOR EACH ROW EXECUTE FUNCTION raw_uploads_payload_guard();

-- Quantities are parsed up to 1e9 L; a tank cannot hold more than 10 million litres.
ALTER TABLE tanks ADD CONSTRAINT tanks_capacity_max_chk CHECK (capacity_litres <= 10000000);
