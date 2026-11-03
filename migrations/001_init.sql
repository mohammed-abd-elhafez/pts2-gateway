-- PTS-2 gateway: initial schema. Rules that must never break live here, not in application code.

-- ---------------------------------------------------------------- reference data
-- Copied from MoEnergy's reference endpoints by the client (PUT /v1/reference).
CREATE TABLE ref_regions (
  id      int PRIMARY KEY CHECK (id > 0),
  name    text NOT NULL,
  name_ar text,
  code    text,
  active  boolean NOT NULL DEFAULT true
);

CREATE TABLE ref_cities (
  id        int PRIMARY KEY CHECK (id > 0),
  region_id int NOT NULL REFERENCES ref_regions (id),
  name      text NOT NULL,
  name_ar   text,
  active    boolean NOT NULL DEFAULT true,
  UNIQUE (id, region_id)
);

CREATE TABLE ref_products (
  product_id int PRIMARY KEY CHECK (product_id > 0),
  name       text NOT NULL,
  active     boolean NOT NULL DEFAULT true
);

-- ---------------------------------------------------------------- stations and tanks
-- Region, city, address and coordinates stay empty until the client supplies the station list.
CREATE TABLE stations (
  id                     bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_code           text,
  name                   text NOT NULL,
  operator_station_code  text NOT NULL CHECK (length(operator_station_code) BETWEEN 1 AND 64),
  moenergy_station_code  text UNIQUE CHECK (moenergy_station_code ~ '^ST-[0-9]{6,}$'),
  region_id              int REFERENCES ref_regions (id),
  city_id                int,
  address                text CHECK (length(address) <= 250),
  latitude               numeric(9, 6) CHECK (latitude BETWEEN 16 AND 32),
  longitude              numeric(9, 6) CHECK (longitude BETWEEN 36 AND 56),
  utc_offset_minutes     int NOT NULL DEFAULT 180 CHECK (utc_offset_minutes BETWEEN -840 AND 840),
  registration_state     text NOT NULL DEFAULT 'draft' CHECK (registration_state IN ('draft', 'ready', 'registered')),
  secret_hash            text NOT NULL UNIQUE,
  last_seen_at           timestamptz,
  created_at             timestamptz NOT NULL DEFAULT now(),
  -- a city must belong to the region it is filed under (skipped while either is empty)
  FOREIGN KEY (city_id, region_id) REFERENCES ref_cities (id, region_id)
);
CREATE UNIQUE INDEX stations_operator_code_uq ON stations (lower(operator_station_code));

CREATE TABLE tanks (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  station_id          bigint NOT NULL REFERENCES stations (id),
  tank_number         int NOT NULL CHECK (tank_number > 0),          -- the probe number
  operator_tank_code  text NOT NULL CHECK (length(operator_tank_code) BETWEEN 1 AND 64),
  moenergy_tank_code  text UNIQUE CHECK (moenergy_tank_code ~ '^ST-[0-9]{6,}-[0-9]+$'),
  product_id          int REFERENCES ref_products (product_id),
  capacity_litres     numeric(14, 3) NOT NULL CHECK (capacity_litres > 0),
  total_height_m      numeric(8, 3) NOT NULL CHECK (total_height_m > 0),
  registration_state  text NOT NULL DEFAULT 'draft' CHECK (registration_state IN ('draft', 'ready', 'registered')),
  chain_held          boolean NOT NULL DEFAULT false,
  is_active           boolean NOT NULL DEFAULT true,
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (station_id, tank_number)
);
CREATE UNIQUE INDEX tanks_operator_code_uq ON tanks (station_id, lower(operator_tank_code));

-- ---------------------------------------------------------------- raw uploads
CREATE TABLE raw_uploads (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  station_id    bigint NOT NULL REFERENCES stations (id),
  arrived_at    timestamptz NOT NULL DEFAULT now(),
  method        text NOT NULL,
  path          text NOT NULL,        -- secret already removed
  query         text,
  headers       jsonb NOT NULL,       -- credentials already removed
  content_type  text,
  body_bytes    int NOT NULL CHECK (body_bytes >= 0),
  body_raw      bytea NOT NULL,       -- exactly what the device sent
  body_json     jsonb,                -- set only when the body parses as JSON
  packet_types  text[] NOT NULL DEFAULT '{}',
  parse_status  text NOT NULL DEFAULT 'captured' CHECK (parse_status IN ('captured', 'parsed', 'failed'))
);
CREATE INDEX raw_uploads_station_time_idx ON raw_uploads (station_id, arrived_at);

-- The payload is never edited after insert; only the parse bookkeeping may change.
CREATE FUNCTION raw_uploads_payload_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW (NEW.station_id, NEW.arrived_at, NEW.method, NEW.path, NEW.query, NEW.headers,
          NEW.content_type, NEW.body_bytes, NEW.body_raw, NEW.body_json)
     IS DISTINCT FROM
     ROW (OLD.station_id, OLD.arrived_at, OLD.method, OLD.path, OLD.query, OLD.headers,
          OLD.content_type, OLD.body_bytes, OLD.body_raw, OLD.body_json)
  THEN
    RAISE EXCEPTION 'raw_uploads payload is immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER raw_uploads_payload_guard BEFORE UPDATE ON raw_uploads
  FOR EACH ROW EXECUTE FUNCTION raw_uploads_payload_guard();

-- ---------------------------------------------------------------- readings
CREATE TABLE readings (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tank_id        bigint NOT NULL REFERENCES tanks (id),
  upload_id      bigint REFERENCES raw_uploads (id),
  device_time    timestamptz,               -- null when the packet carries no time
  content_hash   text,                      -- dedupe fallback when there is no device time
  effective_at   timestamptz NOT NULL,      -- the UTC instant we use
  fuel_volume_l  numeric(14, 3),            -- null = no calibration chart (volume_missing)
  water_volume_l numeric(14, 3) NOT NULL DEFAULT 0,
  fuel_height_mm numeric(10, 3) NOT NULL DEFAULT 0,
  water_height_mm numeric(10, 3) NOT NULL DEFAULT 0,
  ullage_l       numeric(14, 3),
  temperature_c  numeric(5, 1),
  probe_status   text,
  alarms         text[] NOT NULL DEFAULT '{}',
  delivery       boolean NOT NULL DEFAULT false,
  quality_flags  text[] NOT NULL DEFAULT '{}',
  ledger_status  text NOT NULL DEFAULT 'pending' CHECK (ledger_status IN ('pending', 'emitted', 'quarantined')),
  created_at     timestamptz NOT NULL DEFAULT now(),
  CHECK (device_time IS NOT NULL OR content_hash IS NOT NULL)
);
CREATE UNIQUE INDEX readings_dedupe_time_uq ON readings (tank_id, device_time) WHERE device_time IS NOT NULL;
CREATE UNIQUE INDEX readings_dedupe_hash_uq ON readings (tank_id, content_hash) WHERE device_time IS NULL;
CREATE INDEX readings_pending_idx ON readings (tank_id, effective_at, id) WHERE ledger_status = 'pending';

-- ---------------------------------------------------------------- batches
CREATE TABLE batches (
  id                   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  sequence_number      bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  status               text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'accepted', 'rejected')),
  item_count           int NOT NULL CHECK (item_count >= 0),
  size_bytes           int NOT NULL CHECK (size_bytes >= 0 AND size_bytes < 1048576),
  correlation_id       uuid NOT NULL DEFAULT gen_random_uuid(),
  moenergy_result_code text,
  item_index           int,
  created_at           timestamptz NOT NULL DEFAULT now(),
  closed_at            timestamptz
);
-- MoEnergy checks each reading against the last one it stored, so only one batch may be in flight.
CREATE UNIQUE INDEX batches_one_open_uq ON batches ((true)) WHERE status = 'open';

-- ---------------------------------------------------------------- the ledger
CREATE TABLE emitted_readings (
  id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tank_id            bigint NOT NULL REFERENCES tanks (id),
  seq                int NOT NULL CHECK (seq > 0),
  reading_id         bigint NOT NULL UNIQUE REFERENCES readings (id),
  effective_at       timestamptz NOT NULL,
  fuel_quantity      numeric(14, 3) NOT NULL,
  consumed_quantity  numeric(14, 3) NOT NULL,
  remaining_quantity numeric(14, 3) NOT NULL,
  temperature_c      numeric(5, 1),
  flags              text[] NOT NULL DEFAULT '{}',
  batch_id           bigint REFERENCES batches (id),
  UNIQUE (tank_id, seq),
  UNIQUE (tank_id, effective_at),
  CHECK (abs(remaining_quantity - (fuel_quantity - consumed_quantity)) <= 1),
  CHECK (consumed_quantity <= fuel_quantity)
);
CREATE INDEX emitted_unsent_idx ON emitted_readings (effective_at, id) WHERE batch_id IS NULL;

-- A person tells us what MoEnergy holds for a tank; the chain continues from that value.
CREATE TABLE chain_anchors (
  id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tank_id            bigint NOT NULL REFERENCES tanks (id),
  remaining_quantity numeric(14, 3) NOT NULL CHECK (remaining_quantity >= 0),
  after_seq          int NOT NULL DEFAULT 0 CHECK (after_seq >= 0),  -- last emitted seq when it was set
  reason             text NOT NULL,
  set_by             text NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE FUNCTION append_only_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END $$;
CREATE TRIGGER chain_anchors_append_only BEFORE UPDATE OR DELETE ON chain_anchors
  FOR EACH ROW EXECUTE FUNCTION append_only_guard();

CREATE TABLE quarantine (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  reading_id bigint NOT NULL REFERENCES readings (id) ON DELETE CASCADE,
  rule_code  text NOT NULL,
  detail     text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (reading_id, rule_code)
);
