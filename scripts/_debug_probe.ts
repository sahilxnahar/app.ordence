import { Pool } from "pg";

async function main() {
  const pool = new Pool({
    connectionString: "postgresql://ordence_app:test_app@localhost:5432/ordence_test",
  });
  const id = crypto.randomUUID();
  const queries = [
    // Replicate what the app writer does: explicit NULL-ish handling
    pool.query(
      `INSERT INTO security_events (tenant_id, event_type, severity, source, subject_type, subject_id, actor_user_id, occurrence_count, detail, reason, occurred_at)
       VALUES ($1, 'auth.password_changed', 'info', 'api/webhooks/clerk', 'user', $2, $3, 1, '{"primaryEmail": null}'::jsonb, 'Clerk password update', now())`,
      [null, id, id],
    ),
    // And the empty-string variant the log seems to show
    pool.query(
      `INSERT INTO security_events (tenant_id, event_type, severity, source, subject_type, subject_id, actor_user_id, occurrence_count, detail, reason, occurred_at)
       VALUES ($1, 'auth.password_changed', 'info', 'api/webhooks/clerk', 'user', $2, $3, 1, '{"primaryEmail": null}'::jsonb, 'Clerk password update', now())`,
      ["", id, id],
    ),
  ];
  for (const q of queries) {
    try {
      await q;
      console.log("INSERT OK");
    } catch (err) {
      console.error("INSERT FAILED:", (err as Error).message);
    }
  }
  await pool.end();
  process.exit(0);
}

main();
