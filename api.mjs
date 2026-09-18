import { getDatabase } from "@netlify/database";

const db = getDatabase();
const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: { "content-type": "application/json", "cache-control": "no-store" }
});

export default async (req) => {
  try {
    const url = new URL(req.url);
    if (req.method === "GET" && url.pathname.endsWith("/api")) {
      const students = await db.sql`SELECT id, name, age, class_group, level, classes, active FROM students ORDER BY name`;
      const attendance = await db.sql`SELECT id, student_id, class_date, class_group, present FROM attendance ORDER BY class_date DESC, id DESC`;
      return json({ students, attendance });
    }

    if (req.method === "POST" && url.pathname.endsWith("/api/student")) {
      const body = await req.json();
      const id = body.id || crypto.randomUUID();
      await db.sql`
        INSERT INTO students (id, name, age, class_group, level, classes, active)
        VALUES (${id}, ${String(body.name || "").trim()}, ${body.age || null}, ${body.class_group}, ${body.level}, ${Number(body.classes || 0)}, ${body.active !== false})
        ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name, age=EXCLUDED.age, class_group=EXCLUDED.class_group, level=EXCLUDED.level, classes=EXCLUDED.classes, active=EXCLUDED.active
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
      await db.sql`
        UPDATE students s SET classes = COALESCE((SELECT COUNT(*) FROM attendance a WHERE a.student_id=s.id AND a.present=TRUE),0)
      `;
      return json({ ok: true });
    }

    return json({ error: "Not found" }, 404);
  } catch (error) {
    console.error(error);
    return json({ error: "Database request failed", detail: error?.message || String(error) }, 500);
  }
};

export const config = { path: "/api" };
