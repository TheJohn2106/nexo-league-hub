import test from "node:test";
import assert from "node:assert/strict";
import { can, roles } from "../src/lib/permissions.ts";

test("matrice des rôles : séparation organisation / commissaires", () => {
  assert.ok(can("owner", "community.manage"));
  assert.ok(!can("organizer", "community.manage"));
  assert.ok(can("organizer", "results.manage"));
  assert.ok(!can("organizer", "protests.decide"));
  assert.ok(can("steward", "protests.decide"));
  assert.ok(!can("steward", "results.manage"));
  assert.ok(can("captain", "team.attendance"));
  assert.ok(!can("captain", "registrations.review"));
  assert.ok(!can("driver", "attendance.manage"));
  for (const r of roles) assert.ok(can(r, "participate"));
  assert.ok(!can(null, "participate"));
});
