import { describe, expect, it } from "vitest";
import { knownHostQuestionPlan } from "./service.js";

describe("known MCP question plans", () => {
  it("keeps creatine as the exposure and hair loss as the outcome", () => {
    const plan = knownHostQuestionPlan("크레아틴을 먹으면 탈모가 생기나요?", "health");

    expect(plan?.topicTerms).toContain("creatine");
    expect(plan?.outcomeTerms).toEqual(["hair loss", "alopecia"]);
    expect(plan?.academicQuery).toContain("creatine supplementation");
  });
});
