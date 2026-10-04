import { describe, expect, it } from "vitest";

import {
  joinRequestIdempotencyKey,
  planJoinRequestAction,
  planJoinRequestActions,
} from "../src/joinRequest.js";
import { DEFAULT_CONFIG, resolveConfig } from "../src/config.js";

const HUMAN_PENDING = {
  requestId: "jr-1",
  requesterKind: "human",
  requesterRef: "new-member",
  status: "pending",
};

describe("planJoinRequestAction", () => {
  it("is a flag-off no-op: skips without validating when disabled", () => {
    const plan = planJoinRequestAction(HUMAN_PENDING, { enabled: false });
    expect(plan).toMatchObject({
      requestId: "jr-1",
      decision: "skip",
      proposal: null,
      mode: "propose",
      idempotencyKey: "join-request:jr-1",
    });
    expect(plan.reason).toContain("flag off");
  });

  it("routes a human request to a propose-only CEO-digest proposal when the flag is on", () => {
    const plan = planJoinRequestAction(HUMAN_PENDING, { enabled: true });
    expect(plan).toMatchObject({
      requestId: "jr-1",
      decision: "propose",
      mode: "propose",
      idempotencyKey: joinRequestIdempotencyKey("jr-1"),
    });
    expect(plan.proposal).toMatchObject({
      requestId: "jr-1",
      requesterKind: "human",
      requesterRef: "new-member",
      destination: "ceo-digest",
      grammarStub: "DECIDE joins:jr-1 approve|reject",
      detail: null,
    });
  });

  it("routes an agent request on the same digest path", () => {
    const plan = planJoinRequestAction(
      { ...HUMAN_PENDING, requestId: "jr-2", requesterKind: "agent", requesterRef: "helper-bot" },
      { enabled: true },
    );
    expect(plan.decision).toBe("propose");
    expect(plan.proposal).toMatchObject({
      requesterKind: "agent",
      destination: "ceo-digest",
      grammarStub: "DECIDE joins:jr-2 approve|reject",
    });
  });

  it("never approves: no approve outcome, no live intent, no mutation fields", () => {
    const plan = planJoinRequestAction(HUMAN_PENDING, { enabled: true });
    expect(plan.mode).toBe("propose");
    expect(plan.decision).not.toBe("approve");
    expect(plan.proposal?.destination).toBe("ceo-digest");
    expect(plan.proposal?.destination).not.toBe("approve");
    expect(plan).not.toHaveProperty("applyMutations");
    expect(JSON.stringify(plan)).not.toContain("approve\"");
  });

  it("skips a duplicate key already planned", () => {
    const seen = new Set([joinRequestIdempotencyKey("jr-1")]);
    const plan = planJoinRequestAction(HUMAN_PENDING, { enabled: true, seenKeys: seen });
    expect(plan.decision).toBe("skip");
    expect(plan.proposal).toBeNull();
    expect(plan.reason).toContain("duplicate");
  });

  it("skips non-pending statuses (decided history never re-proposes)", () => {
    for (const status of ["approved", "rejected", "expired", ""]) {
      const plan = planJoinRequestAction({ ...HUMAN_PENDING, status }, { enabled: true });
      expect(plan.decision).toBe("skip");
      expect(plan.proposal).toBeNull();
    }
  });

  it("skips unrecognized requester kinds (budget_alert rows stay out)", () => {
    for (const requesterKind of ["budget_alert", "system", ""]) {
      const plan = planJoinRequestAction({ ...HUMAN_PENDING, requesterKind }, { enabled: true });
      expect(plan.decision).toBe("skip");
      expect(plan.proposal).toBeNull();
      expect(plan.reason).toContain("requester kind");
    }
  });

  it("skips malformed rows with no request id or no requester ref", () => {
    const noId = planJoinRequestAction({ ...HUMAN_PENDING, requestId: "" }, { enabled: true });
    expect(noId.decision).toBe("skip");
    expect(noId.reason).toContain("malformed");
    const noRef = planJoinRequestAction({ ...HUMAN_PENDING, requesterRef: "" }, { enabled: true });
    expect(noRef.decision).toBe("skip");
    expect(noRef.reason).toContain("malformed");
  });
});

describe("planJoinRequestActions", () => {
  it("de-duplicates within the batch on the request key", () => {
    const plans = planJoinRequestActions([HUMAN_PENDING, HUMAN_PENDING], { enabled: true });
    expect(plans.map((plan) => plan.decision)).toEqual(["propose", "skip"]);
    expect(plans[1]?.reason).toContain("duplicate");
  });

  it("keeps keys stable across flag states (idempotent retry)", () => {
    const off = planJoinRequestActions([HUMAN_PENDING], { enabled: false });
    const on = planJoinRequestActions([HUMAN_PENDING], { enabled: true, seenKeys: [] });
    expect(off[0]?.idempotencyKey).toBe(on[0]?.idempotencyKey);
  });

  it("does not mutate the caller's seen set", () => {
    const seen = new Set<string>();
    planJoinRequestActions([HUMAN_PENDING, HUMAN_PENDING], { enabled: true, seenKeys: seen });
    expect(seen.size).toBe(0);
  });
});

describe("joinRequestRoute config", () => {
  it("defaults off and resolves explicitly", () => {
    expect(DEFAULT_CONFIG.joinRequestRoute).toBe(false);
    expect(resolveConfig({}).joinRequestRoute).toBe(false);
    expect(resolveConfig({ joinRequestRoute: true }).joinRequestRoute).toBe(true);
    expect(resolveConfig({ joinRequestRoute: 1 }).joinRequestRoute).toBe(false);
  });
});
