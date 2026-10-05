import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  planBudgetAlertAction,
  type BudgetAlertRouteInput,
} from "../src/budgetAlert.js";
import {
  planDecisionBundleAction,
  type DecisionBundleInput,
} from "../src/decisionBundle.js";
import {
  planJoinRequestAction,
  type JoinRequestInput,
} from "../src/joinRequest.js";

type DiffVerb = "join_request" | "budget_alert" | "decision-bundle";

interface DiffFixture {
  name: string;
  verb: DiffVerb;
  input: Record<string, unknown>;
  advise: Record<string, unknown>;
  enforce: Record<string, unknown>;
}

const fixtures = JSON.parse(
  readFileSync(new URL("./fixtures/advise-enforce-diff-matrix.json", import.meta.url), "utf8"),
) as DiffFixture[];

interface Planned {
  decision: string;
  mode: string;
  idempotencyKey: string;
}

function planBoth(fixture: DiffFixture): { advisePlan: Planned; enforcePlan: Planned } {
  if (fixture.verb === "join_request") {
    const input = fixture.input as unknown as JoinRequestInput;
    const advise = planJoinRequestAction(input, { enabled: false });
    const enforce = planJoinRequestAction(input, { enabled: true });
    return { advisePlan: advise as unknown as Planned, enforcePlan: enforce as unknown as Planned };
  }
  if (fixture.verb === "budget_alert") {
    const input = fixture.input as unknown as BudgetAlertRouteInput;
    const advise = planBudgetAlertAction(input, { applyMutations: false });
    const enforce = planBudgetAlertAction(input, { applyMutations: true });
    return { advisePlan: advise as unknown as Planned, enforcePlan: enforce as unknown as Planned };
  }
  const input = fixture.input as unknown as DecisionBundleInput;
  const advise = planDecisionBundleAction(input, { enabled: false });
  const enforce = planDecisionBundleAction(input, { enabled: true });
  return { advisePlan: advise as unknown as Planned, enforcePlan: enforce as unknown as Planned };
}

// Advise-vs-enforce decision-diff matrix for the three newest route verbs
// (join_request, budget_alert, decision-bundle). Fixtures only, flag-gated:
// advise runs the planner with the route flag off, enforce with it on, and
// the only asserted deltas are decision/proposal presence (join_request,
// decision-bundle) plus mode (budget_alert). No enforcement behavior change —
// no src edits, no live calls, no new capabilities.
describe("advise-vs-enforce diff matrix", () => {
  for (const fixture of fixtures) {
    it(`${fixture.name} [advise]`, () => {
      const { advisePlan } = planBoth(fixture);
      expect(advisePlan).toMatchObject(fixture.advise);
    });

    it(`${fixture.name} [enforce]`, () => {
      const { enforcePlan } = planBoth(fixture);
      expect(enforcePlan).toMatchObject(fixture.enforce);
    });

    it(`${fixture.name} [diff invariants]`, () => {
      const { advisePlan, enforcePlan } = planBoth(fixture);
      // Retry-safe across modes: the flag never renames the idempotency scope.
      expect(enforcePlan.idempotencyKey).toBe(advisePlan.idempotencyKey);
      if (fixture.verb === "budget_alert") {
        // Budget alerts mark live intent behind the flag (still no live call).
        expect(advisePlan.mode).toBe("propose");
        expect(enforcePlan.mode).toBe("apply");
      } else {
        // join_request and decision-bundle never mark live intent in either mode.
        expect(advisePlan.mode).toBe("propose");
        expect(enforcePlan.mode).toBe("propose");
      }
    });
  }

  it("covers all three verbs with both advise and enforce expectations", () => {
    const verbs = new Set(fixtures.map((fixture) => fixture.verb));
    expect([...verbs].sort()).toEqual(["budget_alert", "decision-bundle", "join_request"]);
    for (const fixture of fixtures) {
      expect(Object.keys(fixture.advise).length).toBeGreaterThan(0);
      expect(Object.keys(fixture.enforce).length).toBeGreaterThan(0);
    }
  });
});
