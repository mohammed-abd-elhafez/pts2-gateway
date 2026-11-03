-- Batches and API keys belong to a station, so one station's stuck batch cannot hold up the others.

ALTER TABLE batches ADD COLUMN station_id bigint REFERENCES stations (id);

-- Before this migration there was one open batch for everything, and it can hold items of several
-- stations. It cannot be given a single station, so refuse to migrate until it has been closed.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM batches b
      JOIN emitted_readings e ON e.batch_id = b.id
      JOIN tanks t ON t.id = e.tank_id
     WHERE b.status = 'open'
     GROUP BY b.id
    HAVING count(DISTINCT t.station_id) > 1
  ) THEN
    RAISE EXCEPTION 'an open batch holds readings of several stations: post its result before running this migration';
  END IF;
END $$;

-- Open and accepted batches keep their items, so a single station can be read from them. Batches
-- that cover several stations, and rejected ones (which released their items), stay NULL: they are history.
UPDATE batches b
   SET station_id = s.station_id
  FROM (
    SELECT e.batch_id, min(t.station_id) AS station_id
      FROM emitted_readings e JOIN tanks t ON t.id = e.tank_id
     WHERE e.batch_id IS NOT NULL
     GROUP BY e.batch_id
    HAVING count(DISTINCT t.station_id) = 1
  ) s
 WHERE s.batch_id = b.id AND b.status IN ('open', 'accepted');

-- Every new batch must name its station; rows from before this migration are left alone (NOT VALID).
ALTER TABLE batches ADD CONSTRAINT batches_station_required_chk CHECK (station_id IS NOT NULL) NOT VALID;

-- One open batch per station instead of one overall. The old guarantee is gone for good: deploy this
-- with the previous version of the app stopped.
DROP INDEX batches_one_open_uq;
CREATE UNIQUE INDEX batches_one_open_per_station_uq ON batches (station_id) WHERE status = 'open';
CREATE INDEX batches_station_idx ON batches (station_id);

-- A key is either bound to one station or, when station_id is NULL, valid for all of them.
ALTER TABLE api_clients ADD COLUMN station_id bigint REFERENCES stations (id);
CREATE INDEX api_clients_station_idx ON api_clients (station_id);
