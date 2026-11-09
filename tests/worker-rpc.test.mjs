// Source-only mock host: no installed Paperclip instance or live board is used.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { test } from "node:test";
import manifest from "../dist/manifest.js";

test("built worker speaks baseline JSON-RPC, negotiates methods and shuts down cleanly", { timeout: 20_000 }, async () => {
  const worker = spawn(process.execPath, [new URL("../dist/worker.js", import.meta.url).pathname], {
    stdio: ["pipe", "pipe", "pipe"], env: { PATH: process.env.PATH },
  });
  const exit = once(worker, "exit");
  const lines = createInterface({ input: worker.stdout });
  const pending = new Map();
  const calls = [];
  const logs = [];
  const state = new Map();
  let sequence = 0;
  let stderr = "";
  worker.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-8000); });
  const send = (message) => worker.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  function request(method, params = {}) {
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`RPC timeout: ${method}; ${stderr}`)); }, 5000);
      pending.set(id, { resolve, reject, timer });
      send({ id, method, params });
    });
  }
  function hostCall(method, params) {
    calls.push(method);
    switch (method) {
      case "events.subscribe": return null;
      case "companies.list": return [{ id: "fixture-company" }];
      case "config.get": return {};
      case "issues.list":
      case "approvals.list": return [];
      case "state.get": return state.get(params.stateKey) ?? null;
      case "state.set": state.set(params.stateKey, params.value); return null;
      case "metrics.write": return null;
      default: throw new Error(`Unsupported baseline host method: ${method}`);
    }
  }
  lines.on("line", (line) => {
    try {
      const message = JSON.parse(line);
      assert.equal(message.jsonrpc, "2.0");
      if (message.method && message.id !== undefined) {
        try {
          send({ id: message.id, result: hostCall(message.method, message.params) });
        } catch (error) {
          send({ id: message.id, error: { code: -32601, message: error.message } });
        }
      } else if (message.method === "log") {
        logs.push(message.params);
      } else if (message.id !== undefined) {
        const entry = pending.get(message.id);
        assert.ok(entry, `unexpected response id ${message.id}`);
        clearTimeout(entry.timer);
        pending.delete(message.id);
        entry.resolve(message);
      }
    } catch (error) {
      for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(error); }
      pending.clear();
    }
  });
  try {
    const initialized = await request("initialize", { manifest, config: {}, apiVersion: 1,
      instanceInfo: { instanceId: "mock-instance", hostVersion: "2026.817.0" } });
    assert.equal(initialized.result.ok, true);
    assert.deepEqual(initialized.result.supportedMethods.sort(), ["health", "validateConfig"]);
    assert.equal((await request("health")).result.status, "ok");
    assert.equal((await request("validateConfig", { config: {} })).result.ok, true);
    assert.deepEqual((await request("getData", { key: "sla-metrics", params: {} })).result,
      { error: "companyId param required" });
    const job = { jobKey: "sweep-decisions", runId: "mock-run", trigger: "manual", scheduledAt: new Date().toISOString() };
    const swept = await request("runJob", { job });
    assert.equal(swept.error, undefined);
    assert.ok(calls.includes("companies.list"));
    assert.ok(calls.includes("metrics.write"));
    assert.equal(logs.some((entry) => entry.level === "error"), false, JSON.stringify(logs));
    const data = await request("getData", { key: "sla-metrics", params: { companyId: "fixture-company" } });
    assert.equal(data.result.shadow, true);
    assert.equal(data.result.itemsTotal, 0);
    const unknown = await request("unknownMethod");
    assert.equal(unknown.error.code, -32601);
    assert.match(unknown.error.message, /Unknown method/);
    const missingJob = await request("runJob", { job: { ...job, jobKey: "missing" } });
    assert.equal(typeof missingJob.error.code, "number");
    assert.match(missingJob.error.message, /No handler registered/);
    assert.equal((await request("shutdown")).error, undefined);
    assert.deepEqual(await exit, [0, null]);
    assert.ok(calls.every((method) => ["events.subscribe", "companies.list", "config.get", "issues.list",
      "approvals.list", "state.get", "state.set", "metrics.write"].includes(method)));
  } finally {
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error("test cleanup")); }
    lines.close();
    if (worker.exitCode === null) worker.kill("SIGKILL");
    await exit;
  }
});
