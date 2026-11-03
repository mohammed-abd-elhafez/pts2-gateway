-- Review fixes (F1): a valid reading the chain cannot carry is 'skipped', not 'quarantined'.
ALTER TABLE readings DROP CONSTRAINT readings_ledger_status_check;
ALTER TABLE readings ADD CONSTRAINT readings_ledger_status_check
  CHECK (ledger_status IN ('pending', 'emitted', 'quarantined', 'skipped'));

-- F4/F5: an anchor can say when MoEnergy held that value (readings at or before it are already there),
-- and F7: it can let the next reading pass as a refill even under the hold policy.
ALTER TABLE chain_anchors
  ADD COLUMN as_of timestamptz,
  ADD COLUMN accept_negative boolean NOT NULL DEFAULT false;

-- F8: set when MoEnergy has refused a negative consumed quantity for this tank. From then on the tank
-- holds such readings instead of sending them one by one to be refused.
ALTER TABLE tanks ADD COLUMN negative_refused_at timestamptz;
