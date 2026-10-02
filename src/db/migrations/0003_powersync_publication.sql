-- The publication the PowerSync service replicates from. Named `powersync`
-- because the service looks for exactly that name. Listed table by table —
-- never FOR ALL TABLES — so the write-ahead log PowerSync reads carries the
-- synced record types and nothing else: no device credentials, no ledger, no
-- invites, no enrollment codes. Adding a synced table means adding it here in
-- that table's migration.
CREATE PUBLICATION powersync FOR TABLE
  facilities,
  staff,
  units,
  roster_shifts,
  devices,
  patients,
  visits,
  handoffs,
  appointments,
  referrals,
  register_definitions,
  register_entries,
  stock_items,
  stock_movements,
  audit_events,
  sync_rejections;
