-- Adds the start date of the current 12-month belt cycle for each student.
-- Existing students default to their enrollment date.
ALTER TABLE students ADD COLUMN IF NOT EXISTS cycle_start DATE NOT NULL DEFAULT CURRENT_DATE;

UPDATE students SET cycle_start = created_at::date WHERE cycle_start = CURRENT_DATE;
