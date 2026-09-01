import { createHmac } from "node:crypto";

const CORE = "http://localhost:8081";
const SOURCE_SECRET = process.env.CORE_SIGNING_SECRET;
const ORG_ID = process.env.CORE_ORG_ID || "acme";

if (!SOURCE_SECRET) {
  console.error("CORE_SIGNING_SECRET env var required");
  process.exit(1);
}

function signedHeaders(method, path, raw) {
  const nowSec = Math.floor(Date.now() / 1000);
  const canonical = `${method}\n${path}\n${raw}`;
  const signature = `v0=${createHmac("sha256", SOURCE_SECRET).update(`v0:${nowSec}:${canonical}`).digest("hex")}`;
  return { "x-timestamp": String(nowSec), "x-signature": signature, "x-org-id": ORG_ID };
}

const path = "/v1/runtime-config?scopeId=personal:dev@acme&principalId=dev@acme";
const raw = "";
const headers = signedHeaders("GET", path, raw);
const res = await fetch(`${CORE}${path}`, { method: "GET", headers });
const data = await res.json();
console.log("status:", res.status);
console.log("approvedHarnesses:", data.approvedHarnesses);
console.log("modelsByHarness keys:", Object.keys(data.modelsByHarness ?? {}));
console.log("copilot models:", data.modelsByHarness?.copilot ?? "(absent)");
console.log("effective:", data.effective);
