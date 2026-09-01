import pg from "pg";
import { createHash } from "node:crypto";

const dbName = `qm_dev_${createHash("sha1").update(process.cwd()).digest("hex").slice(0, 12)}`;
const connectionString = `postgres://postgres:qm-dev@localhost:45432/${dbName}`;
const pool = new pg.Pool({ connectionString });
pool.on("error", () => {});

const ORG = `org:${process.env.CORE_ORG_ID ?? "acme"}`;
const desired = process.env.HARNESSES ? process.env.HARNESSES.split(",") : ["pi", "opencode", "codex", "claude", "copilot", "mock"];
const HARNESS = "copilot";

try {
  const existing = await pool.query("SELECT id, json FROM approved_harness_configs WHERE id = $1", [ORG]);
  const current = existing.rows[0]?.json?.ids ?? [];
  const next = [...new Set([...current.filter((id) => id !== "copilot"), HARNESS])];
  const finalList = desired.includes(HARNESS) ? desired : next;
  await pool.query(
    `INSERT INTO approved_harness_configs (id, json) VALUES ($1, $2::jsonb)
     ON CONFLICT (id) DO UPDATE SET json = $2::jsonb`,
    [ORG, JSON.stringify({ scopeId: ORG, ids: finalList })],
  );
  console.log(`approved harnesses for ${ORG}:`, finalList);
} catch (e) {
  console.error("error:", e.message);
} finally {
  await pool.end();
}
