import { CopilotClient } from "@github/copilot-sdk";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

const SESSION_STATE = join(homedir(), ".copilot", "session-state");

let localIds = [];
try {
  localIds = (await readdir(SESSION_STATE)).filter(async (id) => {
    try { await stat(join(SESSION_STATE, id)); return true; } catch { return false; }
  });
} catch { console.log("no local session-state dir"); }

console.log(`local session-state dirs on disk: ${localIds.length}`);
for (const id of localIds.slice(0, 5)) console.log(`  disk: ${id}`);

const client = new CopilotClient({
  useLoggedInUser: true,
  workingDirectory: process.cwd(),
  logLevel: "error",
});

console.log("starting client...");
await client.start();
console.log("client started");

try {
  const sessions = await client.listSessions();
  console.log(`\n=== listSessions() returned ${sessions.length} session(s) ===`);
  const remote = sessions.filter((s) => s.isRemote);
  const local = sessions.filter((s) => !s.isRemote);
  console.log(`  remote (isRemote=true): ${remote.length}`);
  console.log(`  local  (isRemote=false): ${local.length}`);

  const onDiskOnly = localIds.filter((id) => !sessions.some((s) => s.sessionId === id));
  const inSdkOnly = sessions.filter((s) => !localIds.includes(s.sessionId));
  console.log(`\n  on disk but NOT in listSessions(): ${onDiskOnly.length} (orphaned disk sessions)`);
  for (const id of onDiskOnly.slice(0, 5)) console.log(`    disk-only: ${id}`);
  console.log(`  in listSessions() but NOT on disk: ${inSdkOnly.length} (would indicate server-side listing!)`);
  for (const s of inSdkOnly.slice(0, 5)) console.log(`    sdk-only: ${s.sessionId} isRemote=${s.isRemote} summary=${s.summary ?? "(none)"}`);

  console.log(`\n=== sample sessions ===`);
  for (const s of sessions.slice(0, 8)) {
    console.log(`  ${s.sessionId}`);
    console.log(`    isRemote: ${s.isRemote}`);
    console.log(`    summary: ${s.summary ?? "(none)"}`);
    console.log(`    modified: ${s.modifiedTime?.toISOString?.() ?? s.modifiedTime}`);
    if (s.context?.repository) console.log(`    repo: ${s.context.repository}`);
    if (s.context?.branch) console.log(`    branch: ${s.context.branch}`);
    if (s.context?.workingDirectory) console.log(`    cwd: ${s.context.workingDirectory}`);
  }
} catch (e) {
  console.error("listSessions failed:", e.message);
} finally {
  await client.stop();
  console.log("\nclient stopped");
}
