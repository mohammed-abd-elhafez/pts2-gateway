-- Operational checks. One row per problem: level | message. Run by health-check.sh; no row means all is well.
-- Variables: silent_min (minutes without an upload before a station counts as silent).

-- stations that stopped uploading
SELECT 'CRIT', 'station ' || operator_station_code || ' has not uploaded for '
         || round(extract(epoch FROM now() - last_seen_at) / 60)::int || ' min'
  FROM stations
 WHERE last_seen_at IS NOT NULL AND last_seen_at < now() - (:'silent_min' || ' minutes')::interval
UNION ALL
SELECT 'WARN', 'station ' || operator_station_code || ' has never uploaded (created ' || created_at::date || ')'
  FROM stations
 WHERE last_seen_at IS NULL AND created_at < now() - interval '1 day'
UNION ALL
-- a batch the client fetched and never reported
SELECT CASE WHEN b.created_at < now() - interval '2 hours' THEN 'CRIT' ELSE 'WARN' END,
       'station ' || s.operator_station_code || ': batch ' || b.id || ' has been open for '
         || round(extract(epoch FROM now() - b.created_at) / 60)::int || ' min'
  FROM batches b JOIN stations s ON s.id = b.station_id
 WHERE b.status = 'open' AND b.created_at < now() - interval '30 minutes'
UNION ALL
-- a tank that needs a person
SELECT 'CRIT', 'tank ' || coalesce(t.moenergy_tank_code, t.operator_tank_code) || ' is held (' || t.held_reason || ') since '
         || to_char(t.held_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI') || ' UTC'
  FROM tanks t WHERE t.chain_held
UNION ALL
-- readings waiting for the ledger although the tank is not held: nobody is polling the station
SELECT 'WARN', 'station ' || s.operator_station_code || ': ' || count(*) || ' readings pending, the oldest for '
         || round(extract(epoch FROM now() - min(r.created_at)) / 60)::int || ' min (is the client polling?)'
  FROM readings r JOIN tanks t ON t.id = r.tank_id JOIN stations s ON s.id = t.station_id
 WHERE r.ledger_status = 'pending' AND NOT t.chain_held AND r.created_at < now() - interval '30 minutes'
 GROUP BY s.operator_station_code
UNION ALL
-- emitted but never put in a batch
SELECT 'WARN', 'station ' || s.operator_station_code || ': ' || count(*) || ' emitted readings have not been sent for '
         || round(extract(epoch FROM now() - min(e.effective_at)) / 60)::int || ' min'
  FROM emitted_readings e JOIN tanks t ON t.id = e.tank_id JOIN stations s ON s.id = t.station_id
 WHERE e.batch_id IS NULL AND e.effective_at < now() - interval '60 minutes'
 GROUP BY s.operator_station_code
UNION ALL
-- readings being set aside in numbers
SELECT 'WARN', count(*) || ' readings set aside in the last hour: ' || q.rule_code
  FROM quarantine q WHERE q.created_at > now() - interval '1 hour'
 GROUP BY q.rule_code HAVING count(*) >= 20;
