-- A wholly refused change keeps the fields it tried to set (SCHEMA.md §7), as
-- a refused insert already keeps its record: no refused write is lost until a
-- person applies it again or discards it.
ALTER TABLE sync_rejections
  ADD COLUMN refused_changes jsonb CHECK (refused_changes IS NULL OR jsonb_typeof(refused_changes) = 'object');
