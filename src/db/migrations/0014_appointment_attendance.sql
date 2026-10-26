-- Additive booking lifecycle: existing booking mode and fees stay intact.
ALTER TABLE appointments
  ADD COLUMN attendance text CHECK (attendance IN ('booked', 'arrived', 'cancelled', 'no_show')),
  ADD COLUMN activity jsonb CHECK (activity IS NULL OR jsonb_typeof(activity) = 'array');
