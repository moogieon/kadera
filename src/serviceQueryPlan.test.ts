import { describe, expect, it } from "vitest";
import { knownHostQuestionPlan } from "./service.js";

describe("known MCP question plans", () => {
  it("keeps creatine as the exposure and hair loss as the outcome", () => {
    const plan = knownHostQuestionPlan("크레아틴을 먹으면 탈모가 생기나요?", "health");

    expect(plan?.topicTerms).toContain("creatine");
    expect(plan?.outcomeTerms).toEqual(["hair loss", "alopecia"]);
    expect(plan?.academicQuery).toContain("creatine supplementation");
  });

  it("turns the registered broad Mounjaro starter into an efficacy and safety search", () => {
    const plan = knownHostQuestionPlan("마운자로에대해 알려줘", "health");

    expect(plan?.topicTerms).toEqual(["tirzepatide"]);
    expect(plan?.outcomeTerms).toEqual(["weight loss", "glycemic control", "adverse events"]);
    expect(plan?.academicQuery).toContain("tirzepatide");
  });
});
