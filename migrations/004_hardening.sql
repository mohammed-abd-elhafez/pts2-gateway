-- Hardening found in review: invariants moved into the database, audit trail, retention-friendly keys.

-- ------------------------------------------------------------------ raw uploads can be pruned
-- A reading survives the deletion of the raw upload it came from; both lookups are indexed.
ALTER TABLE readings DROP CONSTRAINT readings_upload_id_fkey;
ALTER TABLE readings
  ADD CONSTRAINT readings_upload_id_fkey FOREIGN KEY (upload_id) REFERENCES raw_uploads (id) ON DELETE SET NULL;
CREATE INDEX readings_upload_idx ON readings (upload_id) WHERE upload_id IS NOT NULL;
CREATE INDEX raw_uploads_arrived_idx ON raw_uploads (arrived_at);
ALTER TABLE raw_uploads ADD CONSTRAINT raw_uploads_body_bytes_chk CHECK (body_bytes = octet_length(body_raw));

-- ------------------------------------------------------------------ stations and tanks
-- A city is only checked against its region when both are present, so one without the other is refused.
ALTER TABLE stations ADD CONSTRAINT stations_city_needs_region_chk CHECK (city_id IS NULL OR region_id IS NOT NULL);
ALTER TABLE stations
  ADD CONSTRAINT stations_registered_has_code_chk CHECK (registration_state <> 'registered' OR moenergy_station_code IS NOT NULL);
ALTER TABLE tanks
  ADD CONSTRAINT tanks_registered_complete_chk
  CHECK (registration_state <> 'registered' OR (moenergy_tank_code IS NOT NULL AND product_id IS NOT NULL));

-- Why a tank is on hold, and since when. The two columns are set and cleared together with chain_held.
ALTER TABLE tanks
  ADD COLUMN held_reason text CHECK (held_reason IN ('negative_consumed', 'chain_break', 'moenergy_negative_rejection')),
  ADD COLUMN held_at timestamptz;
-- A tank held before this migration has no recorded reason: it counts as a broken chain until a person anchors it.
UPDATE tanks SET held_reason = 'chain_break', held_at = now() WHERE chain_held;
ALTER TABLE tanks
  ADD CONSTRAINT tanks_held_pair_chk CHECK (chain_held = (held_reason IS NOT NULL) AND chain_held = (held_at IS NOT NULL));

-- ------------------------------------------------------------------ the ledger
-- The construction is exact, so the table now demands exactness (MoEnergy's 1 L tolerance stays as a backstop).
-- NOT VALID: enforced for every new row without scanning the existing ones.
ALTER TABLE emitted_readings
  ADD CONSTRAINT emitted_exact_chk CHECK (remaining_quantity = fuel_quantity - consumed_quantity) NOT VALID,
  ADD CONSTRAINT emitted_nonnegative_chk CHECK (fuel_quantity >= 0 AND remaining_quantity >= 0) NOT VALID;

-- What MoEnergy has accepted is history: its emitted rows can no longer be changed or deleted.
CREATE FUNCTION emitted_accepted_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.batch_id IS NOT NULL AND EXISTS (SELECT 1 FROM batches WHERE id = OLD.batch_id AND status = 'accepted') THEN
    RAISE EXCEPTION 'emitted_readings of an accepted batch are immutable';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER emitted_accepted_guard BEFORE UPDATE OR DELETE ON emitted_readings
  FOR EACH ROW EXECUTE FUNCTION emitted_accepted_guard();

-- Per tank, the oldest unsent rows: what the batch builder reads. Replaces the all-stations index.
CREATE INDEX emitted_unsent_by_tank_idx ON emitted_readings (tank_id, effective_at, id) WHERE batch_id IS NULL;
DROP INDEX emitted_unsent_idx;

CREATE INDEX chain_anchors_tank_idx ON chain_anchors (tank_id, id DESC);

-- ------------------------------------------------------------------ batches
-- A closed batch never changes; closed_at is set exactly when the batch is closed.
ALTER TABLE batches ADD CONSTRAINT batches_closed_at_chk CHECK ((status = 'open') = (closed_at IS NULL));
CREATE FUNCTION batches_closed_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status <> 'open' THEN
    RAISE EXCEPTION 'a closed batch cannot change';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER batches_closed_guard BEFORE UPDATE ON batches
  FOR EACH ROW EXECUTE FUNCTION batches_closed_guard();

-- sha256 of the body when it was built: an open batch is re-read from live rows, and must not drift.
-- attention: the client reported something we could not reconcile; the batch needs a person.
ALTER TABLE batches
  ADD COLUMN body_sha256 text,
  ADD COLUMN attention boolean NOT NULL DEFAULT false;

-- ------------------------------------------------------------------ what MoEnergy said
-- Every result the client posts, with MoEnergy's answer as received. Append-only.
CREATE TABLE batch_results (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  batch_id    bigint NOT NULL REFERENCES batches (id),
  received_at timestamptz NOT NULL DEFAULT now(),
  status_code int NOT NULL,
  body        jsonb,
  action      text NOT NULL,
  replayed    boolean NOT NULL DEFAULT false
);
CREATE INDEX batch_results_batch_idx ON batch_results (batch_id);
CREATE TRIGGER batch_results_append_only BEFORE UPDATE OR DELETE ON batch_results
  FOR EACH ROW EXECUTE FUNCTION append_only_guard();
