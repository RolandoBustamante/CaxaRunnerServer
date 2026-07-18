-- Normalize existing numeric dorsals to at least 3 digits.
-- Safe guard: skip rows that would collide with an already existing padded dorsal in the same race.

UPDATE participants p
SET dorsal = LPAD(p.dorsal, 3, '0')
WHERE p.dorsal IS NOT NULL
  AND p.dorsal ~ '^[0-9]{1,2}$'
  AND NOT EXISTS (
    SELECT 1
    FROM participants other
    WHERE other.race_id = p.race_id
      AND other.dorsal = LPAD(p.dorsal, 3, '0')
      AND other.id <> p.id
  );

UPDATE finishers f
SET dorsal = LPAD(f.dorsal, 3, '0')
WHERE f.dorsal ~ '^[0-9]{1,2}$'
  AND NOT EXISTS (
    SELECT 1
    FROM finishers other
    WHERE other.race_id = f.race_id
      AND other.dorsal = LPAD(f.dorsal, 3, '0')
      AND other.id <> f.id
  );
