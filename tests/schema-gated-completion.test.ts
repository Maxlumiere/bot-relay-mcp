// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.
//
// v2.10 — schema-gated task completion (safety). Server-enforced JSON Schema
// validation of a task's completion result, gating the accepted→completed
// transition. Root cause it kills: the 2026-06-09 false-completion incidents
// (an agent marking a task complete with NO proof). The HEADLINE test is the
// negative control: a non-conforming result is REJECTED and the task never
// falsely completes.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";

const TEST_DB_DIR = path.join(os.tmpdir(), "bot-relay-schemagate-test-" + process.pid);
const TEST_DB_PATH = path.join(TEST_DB_DIR, "relay.db");
process.env.RELAY_DB_PATH = TEST_DB_PATH;
delete process.env.RELAY_AGENT_TOKEN;
delete process.env.RELAY_AGENT_NAME;
delete process.env.RELAY_AGENT_ROLE;
delete process.env.RELAY_AGENT_CAPABILITIES;

const {
  registerAgent,
  postTask,
  updateTask,
  getTask,
  registerTaskSchema,
  getTaskSchema,
  ResultSchemaViolationError,
  SchemaDocumentInvalidError,
  SchemaAlreadyExistsError,
  getDb,
  closeDb,
} = await import("../src/db.js");

const { handleRegisterTaskSchema, handleTaskSchemaGet, handleUpdateTask } = await import("../src/tools/tasks.js");
const { clearSchemaCache } = await import("../src/task-schema-validator.js");

function cleanup() {
  closeDb();
  clearSchemaCache();
  delete process.env.RELAY_SCHEMA_GATING;
  if (fs.existsSync(TEST_DB_DIR)) fs.rmSync(TEST_DB_DIR, { recursive: true, force: true });
}

beforeEach(cleanup);
afterEach(cleanup);

/** Post a ship_pong_v1-gated task and accept it, returning its id. */
function gatedAcceptedTask(): string {
  registerAgent("boss", "orchestrator", ["tasks"]);
  registerAgent("worker", "builder", ["build"]);
  const task = postTask("boss", "worker", "ship it", "do the thing", "normal", "ship_pong_v1");
  updateTask(task.id, "worker", "accept");
  return task.id;
}

const CONFORMING = JSON.stringify({ ci_status: "green", tests_passed: 42, summary: "all green" });

describe("v2.10 — migration + seed schemas (schema v15)", () => {
  it("creates task_schemas table + tasks.schema_id column", () => {
    registerAgent("seed", "worker", ["x"]);
    const taskCols = getDb().prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>;
    expect(taskCols.some((c) => c.name === "schema_id")).toBe(true);
    const tables = getDb()
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='task_schemas'")
      .all();
    expect(tables).toHaveLength(1);
  });

  it("auto-registers the built-in schemas on init", () => {
    registerAgent("seed", "worker", ["x"]);
    for (const id of ["ship_pong_v1", "audit_verdict_v1", "merge_ready_v1"]) {
      expect(getTaskSchema(id)?.id).toBe(id);
    }
  });
});

describe("v2.10 — register_task_schema (hardened, immutable)", () => {
  beforeEach(() => registerAgent("author", "orchestrator", ["manage_schemas"]));

  it("stores a valid schema + getTaskSchema returns the parsed doc", () => {
    const rec = registerTaskSchema("custom_v1", { type: "object", required: ["x"], properties: { x: { type: "string" } } }, "author");
    expect(rec.id).toBe("custom_v1");
    expect(getTaskSchema("custom_v1")?.schemaDoc.required).toEqual(["x"]);
  });

  it("REJECTS a schema document containing $ref (forbidden — ajv compile surface)", () => {
    expect(() =>
      registerTaskSchema("evil_v1", { type: "object", properties: { x: { $ref: "http://evil.example/s.json" } } }, "author"),
    ).toThrow(SchemaDocumentInvalidError);
  });

  it("REJECTS a non-object / malformed schema document", () => {
    expect(() => registerTaskSchema("bad_v1", "not a schema" as unknown, "author")).toThrow(SchemaDocumentInvalidError);
  });

  it("refuses to overwrite an existing id (immutable)", () => {
    registerTaskSchema("dup_v1", { type: "object" }, "author");
    expect(() => registerTaskSchema("dup_v1", { type: "object" }, "author")).toThrow(SchemaAlreadyExistsError);
  });
});

describe("v2.10 — post_task schema_id gating", () => {
  it("stamps schema_id on the task row", () => {
    registerAgent("boss", "orchestrator", ["tasks"]);
    registerAgent("worker", "builder", ["build"]);
    const task = postTask("boss", "worker", "t", "d", "normal", "ship_pong_v1");
    expect(getTask(task.id)?.schema_id).toBe("ship_pong_v1");
  });

  it("rejects an unknown schema_id at post time (fail-closed)", () => {
    registerAgent("boss", "orchestrator", ["tasks"]);
    registerAgent("worker", "builder", ["build"]);
    expect(() => postTask("boss", "worker", "t", "d", "normal", "no_such_schema")).toThrow(/unknown task schema/i);
  });
});

describe("v2.10 — ★ NEGATIVE CONTROL: schema-gated completion (RELAY_SCHEMA_GATING=enforce)", () => {
  beforeEach(() => { process.env.RELAY_SCHEMA_GATING = "enforce"; });

  it("REJECTS a non-conforming result (missing required field) and the task STAYS accepted — no false complete", () => {
    const id = gatedAcceptedTask();
    const bad = JSON.stringify({ ci_status: "green", tests_passed: 42 }); // missing `summary`
    expect(() => updateTask(id, "worker", "complete", bad)).toThrow(ResultSchemaViolationError);
    // The load-bearing assertion: the task was NOT completed.
    expect(getTask(id)?.status).toBe("accepted");

    // ...and a CONFORMING result then completes it.
    const done = updateTask(id, "worker", "complete", CONFORMING);
    expect(done.status).toBe("completed");
    expect(getTask(id)?.status).toBe("completed");
  });

  it("REJECTS a wrong-typed field (tests_passed must be integer)", () => {
    const id = gatedAcceptedTask();
    const bad = JSON.stringify({ ci_status: "green", tests_passed: "lots", summary: "x" });
    expect(() => updateTask(id, "worker", "complete", bad)).toThrow(ResultSchemaViolationError);
    expect(getTask(id)?.status).toBe("accepted");
  });

  it("REJECTS a bad enum value (ci_status must be 'green')", () => {
    const id = gatedAcceptedTask();
    const bad = JSON.stringify({ ci_status: "red", tests_passed: 1, summary: "x" });
    expect(() => updateTask(id, "worker", "complete", bad)).toThrow(ResultSchemaViolationError);
    expect(getTask(id)?.status).toBe("accepted");
  });

  it("REJECTS a non-JSON result (a gated result must parse as JSON)", () => {
    const id = gatedAcceptedTask();
    expect(() => updateTask(id, "worker", "complete", "ship it 🚀 (free text)")).toThrow(ResultSchemaViolationError);
    expect(getTask(id)?.status).toBe("accepted");
  });

  it("REJECTS a missing result entirely", () => {
    const id = gatedAcceptedTask();
    expect(() => updateTask(id, "worker", "complete", undefined)).toThrow(ResultSchemaViolationError);
    expect(getTask(id)?.status).toBe("accepted");
  });
});

describe("v2.10 — gating modes + backward-compat", () => {
  it("WARN (default): a non-conforming result is ALLOWED to complete (shadow mode)", () => {
    delete process.env.RELAY_SCHEMA_GATING; // default warn
    const id = gatedAcceptedTask();
    const done = updateTask(id, "worker", "complete", JSON.stringify({ ci_status: "green" }));
    expect(done.status).toBe("completed");
  });

  it("OFF: validation is skipped entirely", () => {
    process.env.RELAY_SCHEMA_GATING = "off";
    const id = gatedAcceptedTask();
    const done = updateTask(id, "worker", "complete", "anything goes");
    expect(done.status).toBe("completed");
  });

  it("UN-GATED task (no schema_id) completes with free-text exactly as before — even under enforce", () => {
    process.env.RELAY_SCHEMA_GATING = "enforce";
    registerAgent("boss", "orchestrator", ["tasks"]);
    registerAgent("worker", "builder", ["build"]);
    const task = postTask("boss", "worker", "t", "d", "normal"); // no schema_id
    updateTask(task.id, "worker", "accept");
    const done = updateTask(task.id, "worker", "complete", "free text result");
    expect(done.status).toBe("completed");
  });
});

describe("v2.10 — handlers (register_task_schema / task_schema_get / update_task gate)", () => {
  function parse(r: any) { return JSON.parse(r.content[0].text); }

  it("handleRegisterTaskSchema: success then ALREADY_EXISTS then SCHEMA_MISMATCH", () => {
    registerAgent("author", "orchestrator", ["manage_schemas"]);
    const ok = parse(handleRegisterTaskSchema({ name: "h_v1", json_schema: { type: "object" }, agent_name: "author" } as any));
    expect(ok.success).toBe(true);
    const dup = parse(handleRegisterTaskSchema({ name: "h_v1", json_schema: { type: "object" }, agent_name: "author" } as any));
    expect(dup.error_code).toBe("ALREADY_EXISTS");
    const bad = parse(handleRegisterTaskSchema({ name: "h_bad_v1", json_schema: { type: "object", properties: { x: { $ref: "x" } } }, agent_name: "author" } as any));
    expect(bad.error_code).toBe("SCHEMA_MISMATCH");
  });

  it("handleTaskSchemaGet: returns a seeded schema; NOT_FOUND for unknown", () => {
    registerAgent("anyone", "worker", ["x"]);
    const got = parse(handleTaskSchemaGet({ name: "ship_pong_v1" } as any));
    expect(got.success).toBe(true);
    expect(got.json_schema.required).toContain("ci_status");
    const miss = parse(handleTaskSchemaGet({ name: "nope_v1" } as any));
    expect(miss.error_code).toBe("NOT_FOUND");
  });

  it("handleUpdateTask(complete) surfaces RESULT_SCHEMA_VIOLATION under enforce", () => {
    process.env.RELAY_SCHEMA_GATING = "enforce";
    const id = gatedAcceptedTask();
    const out = parse(handleUpdateTask({ task_id: id, agent_name: "worker", action: "complete", result: "{}" } as any));
    expect(out.success).toBe(false);
    expect(out.error_code).toBe("RESULT_SCHEMA_VIOLATION");
    expect(getTask(id)?.status).toBe("accepted");
  });
});
