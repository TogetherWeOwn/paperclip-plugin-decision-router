/**
 * Requesting-path guard: an AI-provider (`purpose="ai"`) `connection_intent`
 * never opens when the requesting agent already has an assigned model lane,
 * and still opens when the agent has no lane.
 *
 * Boundary note: the requesting tool lives in host code
 * (`ops/paperclip/interaction_router.py`); this guard runs at the plugin
 * boundary before open. Non-AI purposes are untouched, malformed rows never
 * open, and no plan ever marks live intent (always `propose`).
 */
import { describe, expect, it } from "vitest";

import {
  connectionIntentIdempotencyKey,
  hasAssignedModelLane,
  planConnectionIntentAction,
  planConnectionIntentActions,
  shouldOpenConnectionIntent,
} from "../src/connectionIntent.js";

const AI_WITH_LANE = {
  provider: "anthropic",
  purpose: "ai",
  requestingAgentId: "agent-a",
  modelLane: "lane-1",
};

const AI_WITH_LANE_FLAG = {
  provider: "anthropic",
  purpose: "ai",
  requestingAgentId: "agent-a",
  hasModelLane: true as const,
};

const AI_WITHOUT_LANE = {
  provider: "anthropic",
  purpose: "ai",
  requestingAgentId: "agent-b",
};

describe("connection_intent lane guard", () => {
  it("agent with lane -> no intent opened (skip)", () => {
    expect(shouldOpenConnectionIntent(AI_WITH_LANE)).toBe(false);
    const plan = planConnectionIntentAction(AI_WITH_LANE);
    expect(plan).toMatchObject({
      decision: "skip",
      mode: "propose",
      idempotencyKey: connectionIntentIdempotencyKey("agent-a", "ai", "anthropic"),
    });
    expect(plan.reason).toContain("already has a model lane");
  });

  it("agent with lane via explicit flag -> no intent opened (skip)", () => {
    expect(shouldOpenConnectionIntent(AI_WITH_LANE_FLAG)).toBe(false);
    const plan = planConnectionIntentAction(AI_WITH_LANE_FLAG);
    expect(plan.decision).toBe("skip");
    expect(plan.reason).toContain("already has a model lane");
  });

  it("agent without lane -> intent still opens", () => {
    expect(shouldOpenConnectionIntent(AI_WITHOUT_LANE)).toBe(true);
    const plan = planConnectionIntentAction(AI_WITHOUT_LANE);
    expect(plan).toMatchObject({
      decision: "open",
      mode: "propose",
      idempotencyKey: connectionIntentIdempotencyKey("agent-b", "ai", "anthropic"),
    });
    expect(plan.reason).toContain("has no model lane");
  });

  it("non-AI purpose with a lane still opens (guard covers ai only)", () => {
    const plan = planConnectionIntentAction({ ...AI_WITH_LANE, purpose: "tool" });
    expect(plan.decision).toBe("open");
    expect(plan.reason).toContain('not "ai"');
    expect(shouldOpenConnectionIntent({ ...AI_WITH_LANE, purpose: "tool" })).toBe(true);
  });

  it("malformed rows never open (fail closed, no junk intent)", () => {
    for (const bad of [
      { ...AI_WITHOUT_LANE, purpose: "" },
      { ...AI_WITHOUT_LANE, requestingAgentId: "" },
    ]) {
      expect(shouldOpenConnectionIntent(bad)).toBe(false);
      const plan = planConnectionIntentAction(bad);
      expect(plan.decision).toBe("skip");
      expect(plan.reason).toContain("malformed");
    }
  });

  it("unknown lane info reads as no lane (fail open — only proven lane is subtracted)", () => {
    expect(hasAssignedModelLane({})).toBe(false);
    expect(hasAssignedModelLane({ modelLane: null, hasModelLane: null })).toBe(false);
    expect(hasAssignedModelLane({ modelLane: "  " })).toBe(false);
    expect(shouldOpenConnectionIntent(AI_WITHOUT_LANE)).toBe(true);
  });

  it("never marks live intent: always propose, no mutation fields", () => {
    for (const input of [AI_WITH_LANE, AI_WITHOUT_LANE]) {
      const plan = planConnectionIntentAction(input);
      expect(plan.mode).toBe("propose");
      expect(plan.decision).not.toBe("connect");
      expect(plan).not.toHaveProperty("applyMutations");
      expect(plan).not.toHaveProperty("connected");
    }
  });

  it("dedups a repeated key instead of planning it twice", () => {
    const plans = planConnectionIntentActions([AI_WITHOUT_LANE, AI_WITHOUT_LANE]);
    expect(plans.map((plan) => plan.decision)).toEqual(["open", "skip"]);
    expect(plans[1]?.reason).toContain("duplicate");
  });
});
