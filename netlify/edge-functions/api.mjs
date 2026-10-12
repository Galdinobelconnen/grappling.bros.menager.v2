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
let sessionIndexOk = false;
async function ensureSchema(db) {
  if (schemaReady) return;
  const existing = await db.sql`SELECT 1 FROM information_schema.columns WHERE table_name = 'students' AND column_name = 'classes_offset'`;
  const hadOffset = existing.length > 0;
  await db.sql`ALTER TABLE students ADD COLUMN IF NOT EXISTS white_degrees INTEGER`;
  await db.sql`ALTER TABLE students ADD COLUMN IF NOT EXISTS colored_degrees INTEGER`;
  await db.sql`ALTER TABLE students ADD COLUMN IF NOT EXISTS red_degrees INTEGER`;
  await db.sql`ALTER TABLE students ADD COLUMN IF NOT EXISTS classes_offset INTEGER NOT NULL DEFAULT 0`;
  await db.sql`ALTER TABLE students ADD COLUMN IF NOT EXISTS birth_date DATE`;
  await db.sql`ALTER TABLE students ADD COLUMN IF NOT EXISTS photo TEXT`;
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
    trial_date DATE,
    phone TEXT,
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`;
  // In case the trials table already existed from an earlier deploy (without these
  // two columns), add them now rather than relying on CREATE TABLE, which only
  // runs on a brand-new table.
  await db.sql`ALTER TABLE trials ADD COLUMN IF NOT EXISTS class_group TEXT`;
  await db.sql`ALTER TABLE trials ADD COLUMN IF NOT EXISTS discipline TEXT`;
  await db.sql`ALTER TABLE trials ADD COLUMN IF NOT EXISTS trial_time TEXT`;
  await db.sql`ALTER TABLE trials ADD COLUMN IF NOT EXISTS trial_date DATE`;
  await db.sql`ALTER TABLE trials ADD COLUMN IF NOT EXISTS phone TEXT`;
  await db.sql`ALTER TABLE trials ADD COLUMN IF NOT EXISTS notes TEXT`;
  // Dated follow-up observations (a JSON list), so notes about a trial can pile up over time.
  await db.sql`ALTER TABLE trials ADD COLUMN IF NOT EXISTS observations TEXT`;
  // Weekly class schedule (the Time Table). weekday: 1 = Monday ... 7 = Sunday. Attendance is
  // recorded per (student, date, class group), so each group gets at most one class per weekday.
  await db.sql`CREATE TABLE IF NOT EXISTS timetable (
    id TEXT PRIMARY KEY,
    weekday INTEGER NOT NULL,
    start_time TEXT NOT NULL,
    end_time TEXT,
    class_group TEXT NOT NULL,
    instructor TEXT,
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`;
  await db.sql`ALTER TABLE timetable ADD COLUMN IF NOT EXISTS end_time TEXT`;
  await db.sql`ALTER TABLE timetable ADD COLUMN IF NOT EXISTS instructor TEXT`;
  await db.sql`ALTER TABLE timetable ADD COLUMN IF NOT EXISTS notes TEXT`;
  await db.sql`ALTER TABLE timetable ADD COLUMN IF NOT EXISTS title TEXT`;
  await db.sql`ALTER TABLE timetable ADD COLUMN IF NOT EXISTS groups TEXT`;
  await db.sql`ALTER TABLE timetable ADD COLUMN IF NOT EXISTS counts BOOLEAN NOT NULL DEFAULT TRUE`;
  // Individual students added to one class on top of its groups (e.g. a younger student training in an older class).
  await db.sql`ALTER TABLE timetable ADD COLUMN IF NOT EXISTS extra_students TEXT`;
  // Attendance is now linked to the class (time table slot) it was taken in. That lets one group have
  // several classes in a day (e.g. noon and evening) and one class have several groups. Older rows keep
  // slot_id empty and behave exactly as before.
  await db.sql`ALTER TABLE attendance ADD COLUMN IF NOT EXISTS slot_id TEXT`;
  try {
    // New uniqueness rule: one record per student, per day, per class. Created BEFORE the old rule is
    // removed, so the table is never left unprotected.
    await db.sql`CREATE UNIQUE INDEX IF NOT EXISTS attendance_student_date_session_uq ON attendance (student_id, class_date, (COALESCE(slot_id, class_group)))`;
    sessionIndexOk = true;
    // The old rule (student + date + group) would block two classes of the same group on the same day.
    await db.sql`
      DO $$
      DECLARE r record;
      BEGIN
        FOR r IN
          SELECT c.conname FROM pg_constraint c
          WHERE c.conrelid = 'attendance'::regclass AND c.contype = 'u'
            AND (SELECT array_agg(a.attname::text ORDER BY a.attname) FROM pg_attribute a
                 WHERE a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)) = ARRAY['class_date','class_group','student_id']
        LOOP
          EXECUTE format('ALTER TABLE attendance DROP CONSTRAINT %I', r.conname);
        END LOOP;
        FOR r IN
          SELECT ic.relname AS idx FROM pg_index i JOIN pg_class ic ON ic.oid = i.indexrelid
          WHERE i.indrelid = 'attendance'::regclass AND i.indisunique AND NOT i.indisprimary
            AND i.indexprs IS NULL AND i.indpred IS NULL
            AND (SELECT array_agg(a.attname::text ORDER BY a.attname) FROM pg_attribute a
                 WHERE a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey::int2[])) = ARRAY['class_date','class_group','student_id']
        LOOP
          EXECUTE format('DROP INDEX %I', r.idx);
        END LOOP;
      END $$
    `;
  } catch (migrationErr) {
    // Never block the whole app because of this step; attendance keeps working the old way.
    console.error("attendance migration problem", migrationErr);
  }
  if (!hadOffset) {
    // first time only: keep each student's current class count as the starting point
    await db.sql`
      UPDATE students s SET classes_offset = COALESCE(s.classes, 0) - COALESCE((
        SELECT COUNT(*) FROM attendance a LEFT JOIN timetable t ON t.id = a.slot_id
        WHERE a.student_id = s.id AND a.present = TRUE AND COALESCE(t.counts, TRUE) AND a.class_date >= s.cycle_start
      ), 0)
    `;
  }
  schemaReady = true;
}

// Recalculates every student's class counter from attendance. Classes marked "does not count"
// (for example an Open Mat) are left out; records of deleted classes still count.
async function recalcClasses(db) {
  await db.sql`
    UPDATE students s SET classes = COALESCE((
      SELECT COUNT(*) FROM attendance a LEFT JOIN timetable t ON t.id = a.slot_id
      WHERE a.student_id = s.id AND a.present = TRUE AND COALESCE(t.counts, TRUE) AND a.class_date >= s.cycle_start
    ), 0) + COALESCE(s.classes_offset, 0)
  `;
}

const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: { "content-type": "application/json", "cache-control": "no-store" }
});

export default async (req) => {
  try {
    // Shared-password gate: set APP_PASSWORD in the Netlify dashboard under
    // Site settings -> Environment variables (never hardcoded here, so it never
    // ends up in GitHub). If APP_PASSWORD isn't set, the gate is skipped — so the
    // site keeps working exactly as before until a password is actually configured.
    const requiredPassword = Deno.env.get("APP_PASSWORD");
    if (requiredPassword) {
      const given = req.headers.get("x-app-password");
      if (given !== requiredPassword) {
        return json({ error: "Unauthorized" }, 401);
      }
    }
    const db = await loadDb();
    await ensureSchema(db);
    const url = new URL(req.url);
    if (req.method === "GET" && url.pathname.endsWith("/api")) {
      const students = await db.sql`SELECT id, name, age, birth_date, photo, class_group, level, classes, active, cycle_start, white_degrees, colored_degrees, red_degrees FROM students ORDER BY name`;
      const attendance = await db.sql`SELECT id, student_id, class_date, class_group, slot_id, present FROM attendance ORDER BY class_date DESC, id DESC`;
      const settingsRows = await db.sql`SELECT key, value FROM app_settings WHERE key IN ('requirements', 'stripeClasses', 'methodology')`;
      let requirements = {}, stripeClasses = {}, methodology = {};
      for (const row of settingsRows) {
        try {
          if (row.key === 'requirements') requirements = JSON.parse(row.value);
          if (row.key === 'stripeClasses') stripeClasses = JSON.parse(row.value);
          if (row.key === 'methodology') methodology = JSON.parse(row.value);
        } catch {}
      }
      // Isolated on purpose: if the trials table ever has a problem, the rest of the
      // dashboard (students, attendance, settings) still loads instead of everything
      // failing together.
      let trials = [];
      try {
        trials = await db.sql`SELECT id, name, class_group, discipline, trial_date, trial_time, phone, notes, observations FROM trials ORDER BY trial_date DESC NULLS LAST, created_at DESC`;
        trials = trials.map((t) => {
          let obs = [];
          try { obs = t.observations ? JSON.parse(t.observations) : []; } catch { obs = []; }
          return { ...t, observations: Array.isArray(obs) ? obs : [] };
        });
      } catch (trialErr) {
        console.error("trials query failed", trialErr);
      }
      // Also isolated: a problem with the time table must not take the whole dashboard down.
      let timetable = [];
      try {
        const ttRows = await db.sql`SELECT id, weekday, start_time, end_time, title, groups, counts, extra_students, class_group, instructor, notes FROM timetable ORDER BY weekday, start_time`;
        timetable = ttRows.map((t) => {
          let groups = [];
          try { groups = t.groups ? JSON.parse(t.groups) : []; } catch { groups = []; }
          if (!Array.isArray(groups) || !groups.length) groups = [t.class_group];
          let extras = [];
          try { extras = t.extra_students ? JSON.parse(t.extra_students) : []; } catch { extras = []; }
          return { ...t, groups, counts: t.counts !== false, extra_students: Array.isArray(extras) ? extras : [] };
        });
      } catch (ttErr) {
        console.error("timetable query failed", ttErr);
      }
      return json({ students, attendance, requirements, stripeClasses, methodology, trials, timetable });
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
        INSERT INTO students (id, name, age, birth_date, photo, class_group, level, classes, classes_offset, active, cycle_start, white_degrees, colored_degrees, red_degrees)
        VALUES (${id}, ${String(body.name || "").trim()}, ${body.age || null}, ${body.birth_date || null}, ${body.photo || null}, ${body.class_group}, ${body.level}, ${Number(body.classes || 0)}, ${Number(body.classes || 0)}, ${body.active !== false}, ${cycleStart}, ${white}, ${colored}, ${red})
        ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name, age=EXCLUDED.age, birth_date=EXCLUDED.birth_date, photo=EXCLUDED.photo, class_group=EXCLUDED.class_group, level=EXCLUDED.level, classes=EXCLUDED.classes, classes_offset=EXCLUDED.classes_offset, active=EXCLUDED.active, cycle_start=EXCLUDED.cycle_start, white_degrees=EXCLUDED.white_degrees, colored_degrees=EXCLUDED.colored_degrees, red_degrees=EXCLUDED.red_degrees
      `;
      return json({ ok: true, id });
    }

    if (req.method === "POST" && url.pathname.endsWith("/api/attendance")) {
      const body = await req.json();
      const rows = Array.isArray(body.records) ? body.records : [];
      for (const r of rows) {
        const slotId = r.slotId ? String(r.slotId) : null;
        if (slotId) {
          // An older record of this student for the same day and group (taken before classes were
          // linked) is adopted by this class instead of being counted twice.
          const adopted = await db.sql`
            UPDATE attendance SET slot_id = ${slotId}, present = ${!!r.present}
            WHERE id = (
              SELECT a.id FROM attendance a
              WHERE a.student_id = ${r.studentId} AND a.class_date = ${r.date} AND a.class_group = ${r.classGroup} AND a.slot_id IS NULL
                AND NOT EXISTS (SELECT 1 FROM attendance x WHERE x.student_id = ${r.studentId} AND x.class_date = ${r.date} AND x.slot_id = ${slotId})
              ORDER BY a.id LIMIT 1
            )
            RETURNING id
          `;
          if (adopted.length) continue;
        }
        if (sessionIndexOk) {
          await db.sql`
            INSERT INTO attendance (student_id, class_date, class_group, slot_id, present)
            VALUES (${r.studentId}, ${r.date}, ${r.classGroup}, ${slotId}, ${!!r.present})
            ON CONFLICT (student_id, class_date, (COALESCE(slot_id, class_group)))
            DO UPDATE SET present=EXCLUDED.present
          `;
        } else {
          await db.sql`
            INSERT INTO attendance (student_id, class_date, class_group, slot_id, present)
            VALUES (${r.studentId}, ${r.date}, ${r.classGroup}, ${slotId}, ${!!r.present})
            ON CONFLICT (student_id, class_date, class_group)
            DO UPDATE SET present=EXCLUDED.present
          `;
        }
      }
      // Recalculate class counts from attendance so the graduation counter stays consistent.
      await recalcClasses(db);
      return json({ ok: true });
    }

    // Removes one student's record for one class on one day (undoing a one-time guest).
    if (req.method === "POST" && url.pathname.endsWith("/api/attendance/delete")) {
      const body = await req.json();
      if (!body.studentId || !body.date || !body.slotId) return json({ error: "Missing student, date or class" }, 400);
      await db.sql`DELETE FROM attendance WHERE student_id = ${body.studentId} AND class_date = ${body.date} AND slot_id = ${String(body.slotId)}`;
      await recalcClasses(db);
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
      const photo = body.photo || null;
      const classGroup = body.class_group || null;
      const active = body.active !== false;
      // Optional: lets the instructor correct the belt-cycle start date from the same form used to add a student.
      const cycleStart = /^\d{4}-\d{2}-\d{2}$/.test(body.cycle_start || "") ? body.cycle_start : null;
      if (body.reset_cycle) {
        await db.sql`
          UPDATE students SET level = ${body.level}, name = COALESCE(${name}, name),
            birth_date = ${birthDate}, photo = ${photo}, class_group = COALESCE(${classGroup}, class_group),
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
              birth_date = ${birthDate}, photo = ${photo}, class_group = COALESCE(${classGroup}, s.class_group),
              active = ${active},
              cycle_start = COALESCE(${cycleStart}::date, s.cycle_start),
              classes = ${classes},
              classes_offset = ${classes} - COALESCE((
                SELECT COUNT(*) FROM attendance a LEFT JOIN timetable t ON t.id = a.slot_id
                WHERE a.student_id = s.id AND a.present = TRUE AND COALESCE(t.counts, TRUE) AND a.class_date >= COALESCE(${cycleStart}::date, s.cycle_start)
              ), 0)
            WHERE s.id = ${body.id}
          `;
        } else {
          await db.sql`
            UPDATE students SET level = ${body.level}, name = COALESCE(${name}, name),
              birth_date = ${birthDate}, photo = ${photo}, class_group = COALESCE(${classGroup}, class_group),
              active = ${active}, cycle_start = COALESCE(${cycleStart}::date, cycle_start)
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

    // Time Table: one row per weekly class slot.
    if (req.method === "POST" && url.pathname.endsWith("/api/timetable")) {
      const body = await req.json();
      const weekday = Number(body.weekday);
      const start = String(body.start_time || "");
      const end = body.end_time ? String(body.end_time) : null;
      const groups = Array.isArray(body.groups) ? [...new Set(body.groups.map((g) => String(g).trim()).filter(Boolean))] : [];
      if (!Number.isInteger(weekday) || weekday < 1 || weekday > 7) return json({ error: "Weekday must be 1 (Monday) to 7 (Sunday)" }, 400);
      if (!/^\d{2}:\d{2}$/.test(start) || (end && !/^\d{2}:\d{2}$/.test(end))) return json({ error: "Times must look like 17:30" }, 400);
      if (end && end <= start) return json({ error: "End time must be after the start time" }, 400);
      if (!groups.length) return json({ error: "Choose at least one group for this class" }, 400);
      const id = body.id || crypto.randomUUID();
      const title = body.title ? String(body.title).trim() : null;
      const counts = body.counts !== false;
      // Editing a class from the form does not send this list, so the existing one is kept.
      const extras = Array.isArray(body.extra_students) ? JSON.stringify([...new Set(body.extra_students.map((x) => String(x)))]) : null;
      await db.sql`
        INSERT INTO timetable (id, weekday, start_time, end_time, class_group, title, groups, counts, extra_students, instructor, notes)
        VALUES (${id}, ${weekday}, ${start}, ${end}, ${groups[0]}, ${title || null}, ${JSON.stringify(groups)}, ${counts}, ${extras}, ${body.instructor ? String(body.instructor).trim() : null}, ${body.notes ? String(body.notes).trim() : null})
        ON CONFLICT (id) DO UPDATE SET weekday=EXCLUDED.weekday, start_time=EXCLUDED.start_time, end_time=EXCLUDED.end_time, class_group=EXCLUDED.class_group, title=EXCLUDED.title, groups=EXCLUDED.groups, counts=EXCLUDED.counts, extra_students=COALESCE(EXCLUDED.extra_students, timetable.extra_students), instructor=EXCLUDED.instructor, notes=EXCLUDED.notes
      `;
      // "counts" may have changed, which changes class totals for the people who attended it.
      await recalcClasses(db);
      return json({ ok: true, id });
    }

    // Deleting a class slot keeps all attendance already recorded for it.
    if (req.method === "POST" && url.pathname.endsWith("/api/timetable/delete")) {
      const body = await req.json();
      if (!body.id) return json({ error: "Missing class id" }, 400);
      await db.sql`DELETE FROM timetable WHERE id = ${body.id}`;
      await recalcClasses(db);
      return json({ ok: true });
    }

    // Methodology: each team's curriculum, saved one group at a time so two people editing
    // different teams never overwrite each other. Shape of one group:
    //   { lessons: [ { id, title, topics: [ { id, text, done, doneAt } ], note } ] }
    if (req.method === "POST" && url.pathname.endsWith("/api/methodology")) {
      const body = await req.json();
      const rows = await db.sql`SELECT value FROM app_settings WHERE key = 'methodology'`;
      let current = {};
      try { current = rows.length ? JSON.parse(rows[0].value) || {} : {}; } catch { current = {}; }
      if (body.group) {
        if (!body.curriculum || !Array.isArray(body.curriculum.lessons)) return json({ error: "Curriculum must contain a list of lessons" }, 400);
        current[String(body.group)] = body.curriculum;
      } else if (body.methodology && typeof body.methodology === "object") {
        current = body.methodology;
      } else {
        return json({ error: "Nothing to save" }, 400);
      }
      const text = JSON.stringify(current);
      if (text.length > 900000) return json({ error: "The curriculum is too large to save" }, 400);
      await db.sql`
        INSERT INTO app_settings (key, value, updated_at) VALUES ('methodology', ${text}, now())
        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()
      `;
      return json({ ok: true });
    }

    // Trial students: simple lead capture, converted into a real student from the UI
    // (which calls POST /api/student followed by this delete route).
    if (req.method === "POST" && url.pathname.endsWith("/api/trial")) {
      const body = await req.json();
      if (!body.name) return json({ error: "Missing name" }, 400);
      const id = body.id || crypto.randomUUID();
      // Observations: [{ id, at: "2026-10-12T09:30", text }]. If the request does not send them, the saved ones are kept.
      const observations = Array.isArray(body.observations)
        ? JSON.stringify(body.observations.slice(0, 200)
            .map((o) => ({ id: String(o.id || crypto.randomUUID()), at: String(o.at || "").slice(0, 16), text: String(o.text || "").trim().slice(0, 2000) }))
            .filter((o) => o.text))
        : null;
      await db.sql`
        INSERT INTO trials (id, name, class_group, discipline, trial_date, trial_time, phone, notes, observations)
        VALUES (${id}, ${String(body.name).trim()}, ${body.class_group || null}, ${body.discipline || null}, ${body.trial_date || null}, ${body.trial_time || null}, ${body.phone || null}, ${body.notes || null}, ${observations})
        ON CONFLICT (id) DO UPDATE SET
          name = EXCLUDED.name, class_group = EXCLUDED.class_group, discipline = EXCLUDED.discipline,
          trial_date = EXCLUDED.trial_date, trial_time = EXCLUDED.trial_time, phone = EXCLUDED.phone, notes = EXCLUDED.notes,
          observations = COALESCE(EXCLUDED.observations, trials.observations)
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
    // Neon's driver often wraps the real Postgres reason (missing column, bad
    // type, constraint, etc.) in extra fields instead of just .message, so we
    // surface everything available rather than the generic wrapper text alone.
    const detail = [
      error?.message,
      error?.detail,
      error?.hint,
      error?.code ? `code: ${error.code}` : null,
      error?.cause?.message
    ].filter(Boolean).join(" | ") || String(error);
    return json({ error: "Database request failed", detail }, 500);
  }
};

export const config = { path: ["/api", "/api/*"] };
