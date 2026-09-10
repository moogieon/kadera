import { describe, expect, it } from "vitest";
import { normalizeFastHostQueryPlan, validateHostMcpLocalization } from "./openai.js";

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

describe("host MCP paper localization validation", () => {
  it("permits participant ages from scope notes but still rejects invented ages", () => {
    const sources = [{paperId: "7017-z", title: "Sleep timing and health", result: "Later sleep timing was associated with poorer health.", scopeNotes: ["Children aged 5 to 18 years were included. Evidence certainty was very low."]}];
    const localized = {
      conclusion_ko: "어린이·청소년에서는 늦은 취침과 건강의 연관성이 있지만 근거 확실성이 매우 낮습니다.",
      papers: [{paper_id: "7017-z", title_ko: "취침 시각과 건강", result_ko: "5~18세에서 늦은 취침과 나쁜 건강의 연관성이 있었지만 근거 확실성은 매우 낮습니다.", headline_ko: "이 연구에서는 어린이·청소년의 취침 시각과 건강에 연관성이 있었습니다."}]
    };
    expect(validateHostMcpLocalization(localized, sources)).toBeDefined();
    expect(validateHostMcpLocalization({...localized, papers: [{...localized.papers[0], result_ko: "25~38세에서 늦은 취침과 나쁜 건강의 연관성이 있었습니다."}]}, sources)).toBeUndefined();
  });

  it("accepts faithful Korean fields and rejects invented numbers", () => {
    const sources = [{
      paperId: "1234-a",
      title: "A 12-week randomized trial",
      result: "Thirty-eight participants completed the 12-week study."
    }];
    const valid = {
      conclusion_ko: "현재 근거만으로는 크레아틴이 탈모를 일으킨다고 보기 어렵습니다.",
      papers: [{
        paper_id: "1234-a",
        title_ko: "12주 무작위 시험",
        result_ko: "참가자 38명이 12주 연구를 완료했습니다.",
        headline_ko: "이 연구에서는 참가자 38명이 12주 연구를 완료했습니다."
      }]
    };

    expect(validateHostMcpLocalization(valid, sources)?.papers[0]?.paperId).toBe("1234-a");
    expect(validateHostMcpLocalization({
      ...valid,
      papers: [{ ...valid.papers[0], result_ko: "참가자 100명이 12주 연구를 완료했습니다." }]
    }, sources)).toBeUndefined();
    expect(validateHostMcpLocalization({
      ...valid,
      papers: [{ ...valid.papers[0], result_ko: "참가자들이 연구를 완료했습니다." }]
    }, sources)?.papers[0]?.resultKo).toBe("참가자들이 연구를 완료했습니다.");
    expect(validateHostMcpLocalization({
      ...valid,
      conclusion_ko: "이 연구에서는 크레아틴과 탈모를 직접 평가했습니다."
    }, sources)).toBeUndefined();
  });
});
