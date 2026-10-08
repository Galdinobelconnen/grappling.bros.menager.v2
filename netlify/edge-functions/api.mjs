// Loads the Netlify Database client lazily so that any loading problem is caught
// and reported as readable JSON instead of crashing the whole edge function.
async function loadDb() {
  let firstError;
  try {
    const m = await import("@netlify/database");
    return m.getDatabase();
  } catch (e) {
    firstError = e;
  }
  try {
    const m = await import("npm:@netlify/database");
    return m.getDatabase();
  } catch (e2) {
    throw new Error(`Could not load the database client. Attempt 1: ${firstError?.message || firstError}. Attempt 2: ${e2?.message || e2}`);
  }
}

// Creates the columns used by manual degrees / manual class counter, if missing.
// classes_offset keeps the classes the instructor typed in (or the ones a student
// already had) so recalculating from attendance never wipes them.
let schemaReady = false;
async function ensureSchema(db) {
  if (schemaReady) return;
  const existing = await db.sql`SELECT 1 FROM information_schema.columns WHERE table_name = 'students' AND column_name = 'classes_offset'`;
  const hadOffset = existing.length > 0;
  await db.sql`ALTER TABLE students ADD COLUMN IF NOT EXISTS white_degrees INTEGER`;
  await db.sql`ALTER TABLE students ADD COLUMN IF NOT EXISTS colored_degrees INTEGER`;
  await db.sql`ALTER TABLE students ADD COLUMN IF NOT EXISTS red_degrees INTEGER`;
  await db.sql`ALTER TABLE students ADD COLUMN IF NOT EXISTS classes_offset INTEGER NOT NULL DEFAULT 0`;
  await db.sql`ALTER TABLE students ADD COLUMN IF NOT EXISTS birth_date DATE`;
  // Simple key/value store for app-wide settings, such as the editable classes-per-belt
  // requirement for Teenagers/Adults (they don't use the kids' quarterly degree system).
  await db.sql`CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`;
  // Trial students: a lightweight lead list, separate from the main students table,
  // for people trying a class before deciding to enroll. "Convert to Student" moves
  // them into students and removes the trial row.
  await db.sql`CREATE TABLE IF NOT EXISTS trials (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    class_group TEXT,
    discipline TEXT,
    trial_date DATE,
    trial_time TEXT,
    phone TEXT,
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`;
  if (!hadOffset) {
    // first time only: keep each student's current class count as the starting point
    await db.sql`
      UPDATE students s SET classes_offset = COALESCE(s.classes, 0) - COALESCE((
        SELECT COUNT(*) FROM attendance a
        WHERE a.student_id = s.id AND a.present = TRUE AND a.class_date >= s.cycle_start
      ), 0)
    `;
  }
  schemaReady = true;
}

const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: { "content-type": "application/json", "cache-control": "no-store" }
});

export default async (req) => {
  try {
    const db = await loadDb();
    await ensureSchema(db);
    const url = new URL(req.url);
    if (req.method === "GET" && url.pathname.endsWith("/api")) {
      const students = await db.sql`SELECT id, name, age, birth_date, class_group, level, classes, active, cycle_start, white_degrees, colored_degrees, red_degrees FROM students ORDER BY name`;
      const attendance = await db.sql`SELECT id, student_id, class_date, class_group, present FROM attendance ORDER BY class_date DESC, id DESC`;
      const settingsRows = await db.sql`SELECT key, value FROM app_settings WHERE key IN ('requirements', 'stripeClasses')`;
      let requirements = {}, stripeClasses = {};
      for (const row of settingsRows) {
        try {
          if (row.key === 'requirements') requirements = JSON.parse(row.value);
          if (row.key === 'stripeClasses') stripeClasses = JSON.parse(row.value);
        } catch {}
      }
      const trials = await db.sql`SELECT id, name, class_group, discipline, trial_date, trial_time, phone, notes FROM trials ORDER BY trial_date DESC NULLS LAST, created_at DESC`;
      return json({ students, attendance, requirements, stripeClasses, trials });
    }

    // Saves two editable settings blobs in one call:
    // requirements: classes-per-belt for Teenagers/Adults, e.g. { "Teenagers": { "White": 30 } }
    // stripeClasses: classes per colored stripe for kids groups, e.g. { "Tiny Tots": 12 }
    if (req.method === "POST" && url.pathname.endsWith("/api/settings")) {
      const body = await req.json();
      const requirements = body.requirements || {};
      const stripeClasses = body.stripeClasses || {};
      await db.sql`
        INSERT INTO app_settings (key, value, updated_at) VALUES ('requirements', ${JSON.stringify(requirements)}, now())
        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()
      `;
      await db.sql`
        INSERT INTO app_settings (key, value, updated_at) VALUES ('stripeClasses', ${JSON.stringify(stripeClasses)}, now())
        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()
      `;
      return json({ ok: true });
    }

    if (req.method === "POST" && url.pathname.endsWith("/api/student")) {
      const body = await req.json();
      const id = body.id || crypto.randomUUID();
      const cycleStart = body.cycle_start || new Date().toISOString().slice(0, 10);
      // Degrees are optional at creation time: when provided (an existing student being
      // entered into the system mid-progress), they start in manual mode right away.
      const white = Number.isInteger(body.white_degrees) ? body.white_degrees : null;
      const colored = Number.isInteger(body.colored_degrees) ? body.colored_degrees : null;
      const red = Number.isInteger(body.red_degrees) ? body.red_degrees : null;
      await db.sql`
        INSERT INTO students (id, name, age, birth_date, class_group, level, classes, classes_offset, active, cycle_start, white_degrees, colored_degrees, red_degrees)
        VALUES (${id}, ${String(body.name || "").trim()}, ${body.age || null}, ${body.birth_date || null}, ${body.class_group}, ${body.level}, ${Number(body.classes || 0)}, ${Number(body.classes || 0)}, ${body.active !== false}, ${cycleStart}, ${white}, ${colored}, ${red})
        ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name, age=EXCLUDED.age, birth_date=EXCLUDED.birth_date, class_group=EXCLUDED.class_group, level=EXCLUDED.level, classes=EXCLUDED.classes, classes_offset=EXCLUDED.classes_offset, active=EXCLUDED.active, cycle_start=EXCLUDED.cycle_start, white_degrees=EXCLUDED.white_degrees, colored_degrees=EXCLUDED.colored_degrees, red_degrees=EXCLUDED.red_degrees
      `;
      return json({ ok: true, id });
    }

    if (req.method === "POST" && url.pathname.endsWith("/api/attendance")) {
      const body = await req.json();
      const rows = Array.isArray(body.records) ? body.records : [];
      for (const r of rows) {
        await db.sql`
          INSERT INTO attendance (student_id, class_date, class_group, present)
          VALUES (${r.studentId}, ${r.date}, ${r.classGroup}, ${!!r.present})
          ON CONFLICT (student_id, class_date, class_group)
          DO UPDATE SET present=EXCLUDED.present
        `;
      }
      // Recalculate class counts from attendance so the graduation counter stays consistent.
      // Only counts classes attended since the student's current 12-month belt cycle began.
      await db.sql`
        UPDATE students s SET classes = COALESCE((
          SELECT COUNT(*) FROM attendance a
          WHERE a.student_id=s.id AND a.present=TRUE AND a.class_date >= s.cycle_start
        ),0) + COALESCE(s.classes_offset, 0)
      `;
      return json({ ok: true });
    }

    if (req.method === "POST" && url.pathname.endsWith("/api/student/promote")) {
      const body = await req.json();
      if (!body.id) return json({ error: "Missing student id" }, 400);
      const nextLevel = body.next_level || null;
      await db.sql`
        UPDATE students
        SET classes = 0,
            classes_offset = 0,
            cycle_start = CURRENT_DATE,
            white_degrees = NULL, colored_degrees = NULL, red_degrees = NULL,
            level = COALESCE(${nextLevel}, level)
        WHERE id = ${body.id}
      `;
      return json({ ok: true });
    }

    // Manual belt edit by the instructor, separate from the automatic promote flow.
    // reset_cycle=true zeroes the class count and restarts the 12-month cycle.
    // reset_cycle=false keeps the cycle, and lets the instructor set the class
    // count directly to whatever number is provided (manual counter control).
    // Full student edit: name, date of birth, class group and belt all in one call,
    // plus the same manual class-count / reset-cycle behavior as before. Changing
    // class_group is how a student is moved to a different class (e.g. Kids 1 -> Kids 2).
    if (req.method === "POST" && url.pathname.endsWith("/api/student/edit-belt")) {
      const body = await req.json();
      if (!body.id || !body.level) return json({ error: "Missing id or level" }, 400);
      const name = body.name != null ? String(body.name).trim() : null;
      const birthDate = body.birth_date || null;
      const classGroup = body.class_group || null;
      const active = body.active !== false;
      if (body.reset_cycle) {
        await db.sql`
          UPDATE students SET level = ${body.level}, name = COALESCE(${name}, name),
            birth_date = ${birthDate}, class_group = COALESCE(${classGroup}, class_group),
            active = ${active},
            classes = 0, classes_offset = 0, cycle_start = CURRENT_DATE,
            white_degrees = NULL, colored_degrees = NULL, red_degrees = NULL
          WHERE id = ${body.id}
        `;
      } else {
        const classes = Number.isFinite(Number(body.classes)) ? Number(body.classes) : null;
        if (classes !== null) {
          await db.sql`
            UPDATE students s SET level = ${body.level}, name = COALESCE(${name}, s.name),
              birth_date = ${birthDate}, class_group = COALESCE(${classGroup}, s.class_group),
              active = ${active},
              classes = ${classes},
              classes_offset = ${classes} - COALESCE((
                SELECT COUNT(*) FROM attendance a
                WHERE a.student_id = s.id AND a.present = TRUE AND a.class_date >= s.cycle_start
              ), 0)
            WHERE s.id = ${body.id}
          `;
        } else {
          await db.sql`
            UPDATE students SET level = ${body.level}, name = COALESCE(${name}, name),
              birth_date = ${birthDate}, class_group = COALESCE(${classGroup}, class_group),
              active = ${active}
            WHERE id = ${body.id}
          `;
        }
      }
      return json({ ok: true });
    }

    // Manual degrees: the instructor sets exactly how many degrees a student has now.
    // { id, auto: true } goes back to the automatic calculation.
    if (req.method === "POST" && url.pathname.endsWith("/api/student/set-degrees")) {
      const body = await req.json();
      if (!body.id) return json({ error: "Missing student id" }, 400);
      if (body.auto) {
        await db.sql`
          UPDATE students SET white_degrees = NULL, colored_degrees = NULL, red_degrees = NULL
          WHERE id = ${body.id}
        `;
        return json({ ok: true, mode: "auto" });
      }
      const w = Number(body.white), c = Number(body.colored), r = Number(body.red);
      const valid = [w, c, r].every(n => Number.isInteger(n) && n >= 0 && n <= 4);
      if (!valid) return json({ error: "Degrees must be whole numbers from 0 to 4" }, 400);
      if (w + r > 4) return json({ error: "White + red overlay degrees cannot be more than 4" }, 400);
      await db.sql`
        UPDATE students SET white_degrees = ${w}, colored_degrees = ${c}, red_degrees = ${r}
        WHERE id = ${body.id}
      `;
      return json({ ok: true, mode: "manual" });
    }

    // Deletes a student and their attendance history. Irreversible.
    if (req.method === "POST" && url.pathname.endsWith("/api/student/delete")) {
      const body = await req.json();
      if (!body.id) return json({ error: "Missing student id" }, 400);
      await db.sql`DELETE FROM attendance WHERE student_id = ${body.id}`;
      await db.sql`DELETE FROM students WHERE id = ${body.id}`;
      return json({ ok: true });
    }

    // Trial students: simple lead capture, converted into a real student from the UI
    // (which calls POST /api/student followed by this delete route).
    if (req.method === "POST" && url.pathname.endsWith("/api/trial")) {
      const body = await req.json();
      if (!body.name) return json({ error: "Missing name" }, 400);
      const id = body.id || crypto.randomUUID();
      await db.sql`
        INSERT INTO trials (id, name, class_group, discipline, trial_date, trial_time, phone, notes)
        VALUES (${id}, ${String(body.name).trim()}, ${body.class_group || null}, ${body.discipline || null}, ${body.trial_date || null}, ${body.trial_time || null}, ${body.phone || null}, ${body.notes || null})
      `;
      return json({ ok: true, id });
    }

    if (req.method === "POST" && url.pathname.endsWith("/api/trial/delete")) {
      const body = await req.json();
      if (!body.id) return json({ error: "Missing trial id" }, 400);
      await db.sql`DELETE FROM trials WHERE id = ${body.id}`;
      return json({ ok: true });
    }

    // One-off migration route: adds the cycle_start column if it's missing yet.
    // Safe to call more than once (IF NOT EXISTS). Visit this URL once in the
    // browser after deploying, then this route can be removed later if you like.
    if (req.method === "GET" && url.pathname.endsWith("/api/migrate")) {
      await db.sql`ALTER TABLE students ADD COLUMN IF NOT EXISTS cycle_start DATE NOT NULL DEFAULT CURRENT_DATE`;
      await db.sql`UPDATE students SET cycle_start = created_at::date WHERE cycle_start = CURRENT_DATE`;
      return json({ ok: true, migrated: true });
    }

    return json({ error: "Not found" }, 404);
  } catch (error) {
    console.error(error);
    return json({ error: "Database request failed", detail: error?.message || String(error) }, 500);
  }
};

export const config = { path: ["/api", "/api/*"] };
