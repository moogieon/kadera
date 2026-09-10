import { describe, expect, it } from "vitest";
import { hostEvidenceSearchBudgetMs, knownHostQuestionPlan } from "./service.js";

it("reserves proxy and serialization time inside Kakao's three-second deadline", () => {
  expect(hostEvidenceSearchBudgetMs).toBeLessThanOrEqual(1_800);
});

describe("known MCP question plans", () => {
  it("keeps late-bedtime paraphrases on the same exposure without generic sleep outcomes", () => {
    const questions = ["늦게 자면 몸에 안 좋다", "늦게 자면 몸에 안 좋아?", "늦게 자는 습관은 건강에 해로운가?", "늦게 자는 게 몸에 안 좋다는 말이 사실인가?"];
    const plans = questions.map((question) => knownHostQuestionPlan(question, "health"));
    expect(plans.every((plan) => JSON.stringify(plan) === JSON.stringify(plans[0]))).toBe(true);
    expect(plans[0]?.topicTerms).toContain("late bedtime");
    expect(plans[0]?.topicTerms).not.toContain("sleep");
    expect(plans[0]?.outcomeTerms).toEqual([]);
    expect(knownHostQuestionPlan("늦게 자면 당뇨 위험이 높아?", "health")?.outcomeTerms).toContain("diabetes");
    expect(knownHostQuestionPlan("교대 근무 때문에 늦게 자요", "health")).toBeUndefined();
  });
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

  it("plans the zero-soda starter without a generic adverse-effects endpoint", () => {
    const plan = knownHostQuestionPlan("제로 탄산이 몸에 안좋다던데 진짜 몸에 안좋은가?", "nutrition");

    expect(plan?.topicTerms).toContain("artificially sweetened beverages");
    expect(plan?.outcomeTerms).toEqual([]);
    expect(plan?.academicQuery).toContain("sugar-sweetened beverages");
    expect(plan?.academicQuery).not.toMatch(/\badverse effects\b/i);
  });

  it("plans the handwriting-versus-typing starter without a model call", () => {
    const plan = knownHostQuestionPlan("손필기가 타이핑보다 공부에 더 좋아?", "education");

    expect(plan?.topicTerms).toEqual(expect.arrayContaining(["longhand note taking", "laptop note taking"]));
    expect(plan?.outcomeTerms).toEqual([]);
    expect(plan?.academicQuery).toContain("learning performance");
  });
});
