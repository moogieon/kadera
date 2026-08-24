import { loadConfig } from "./config.js";
import { prewarmQuestions } from "./prewarmQuestions.js";
import { ClaimCheckerService } from "./service.js";

const config = loadConfig();
const service = new ClaimCheckerService(config);
const start = clampInt(process.env.PREWARM_START, 0, prewarmQuestions.length - 1, 0);
const limit = clampInt(process.env.PREWARM_LIMIT, 1, prewarmQuestions.length, prewarmQuestions.length);
const concurrency = clampInt(process.env.PREWARM_CONCURRENCY, 1, 3, 1);
const questions = prewarmQuestions.slice(start, start + limit);
let cursor = 0;
let succeeded = 0;
let failed = 0;

async function worker(): Promise<void> {
  while (true) {
    const index = cursor++;
    const question = questions[index];
    if (!question) return;
    const startedAt = Date.now();
    try {
      const answer = await service.checkClaimVerified({ question, limit: 5 });
      // The web answer cache and the MCP retrieval cache are separate stores.
      // Warming only the former leaves the first Kakao user of every topic
      // paying a full live search, which is what the average-latency budget
      // cannot absorb. Resolve the query the host would send and warm that too.
      const hostPapers = await prewarmHostEvidence(question);
      succeeded += 1;
      process.stdout.write(
        `${String(index + 1).padStart(3, "0")}/${questions.length} ok ${Date.now() - startedAt}ms ${answer.citations.length} citations, mcp ${hostPapers}\n`
      );
    } catch (error) {
      failed += 1;
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`${String(index + 1).padStart(3, "0")}/${questions.length} failed ${message}\n`);
    }
  }
}

try {
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
} finally {
  service.close();
}

process.stdout.write(`prewarm complete: ${succeeded} succeeded, ${failed} failed\n`);
if (failed > 0) process.exitCode = 1;

async function prewarmHostEvidence(question: string): Promise<string> {
  const planned = await service.planHostQuery(question).catch(() => undefined);
  if (!planned) return "쿼리 미해결";
  const evidence = await service.findHostEvidence({
    question,
    academicQuery: planned.academicQuery,
    category: planned.category
  });
  return `${evidence.papers.length}편`;
}

function clampInt(value: string | undefined, min: number, max: number, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(parsed)));
}
