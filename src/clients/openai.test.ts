import { describe, expect, it } from "vitest";
import { normalizeFastHostQueryPlan } from "./openai.js";

describe("fast host query planning", () => {
  it("turns verbose model labels into stable exposure and outcome search terms", () => {
    const plan = normalizeFastHostQueryPlan({
      topic_terms: ["creatine exposure", "creatine supplementation", "creatine monohydrate"],
      outcome_terms: ["hair loss outcome", "alopecia", "dandruff (not primary)"],
      category: "health"
    }, "health");

    expect(plan.topicTerms[0]).toBe("creatine");
    expect(plan.topicTerms).toContain("creatine monohydrate");
    expect(plan.outcomeTerms).toEqual(["hair loss", "alopecia"]);
    expect(plan.academicQuery).toBe(
      "creatine creatine exposure creatine supplementation hair loss alopecia systematic review randomized controlled trial"
    );
    expect(plan.academicQuery).not.toMatch(/[()\"]|\bAND\b|\bOR\b/);
  });

  it("falls back to the deterministic category when the model returns an invalid label", () => {
    const plan = normalizeFastHostQueryPlan({
      topic_terms: ["intermittent fasting", "time restricted eating"],
      outcome_terms: ["body weight"],
      category: "health | nutrition"
    }, "nutrition");

    expect(plan.category).toBe("nutrition");
  });
});
