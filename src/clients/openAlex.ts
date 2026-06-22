import type { Config } from "../config.js";
import { inferEvidenceLevel } from "../evidence.js";
import type { Paper } from "../types.js";

interface OpenAlexResponse {
  results?: OpenAlexWork[];
}

interface OpenAlexWork {
  id?: string;
  doi?: string;
  display_name?: string;
  publication_year?: number;
  authorships?: Array<{
    author?: { display_name?: string };
    institutions?: Array<{ display_name?: string }>;
  }>;
  type_crossref?: string;
  type?: string;
  cited_by_count?: number;
  abstract_inverted_index?: Record<string, number[]>;
  primary_location?: {
    landing_page_url?: string;
    source?: { display_name?: string };
  };
}

export class OpenAlexClient {
  constructor(private readonly config: Config, private readonly fetchFn: typeof fetch = fetch) {}

  async search(query: string, limit: number): Promise<Paper[]> {
    const url = new URL("https://api.openalex.org/works");
    url.searchParams.set("search", query);
    url.searchParams.set("per-page", String(limit));
    if (this.config.contactEmail) url.searchParams.set("mailto", this.config.contactEmail);

    const response = await this.fetchFn(url);
    if (!response.ok) throw new Error(`OpenAlex search failed: ${response.status}`);
    const json = (await response.json()) as OpenAlexResponse;
    return (json.results ?? []).map(toPaper).filter((paper): paper is Paper => Boolean(paper));
  }
}

function toPaper(work: OpenAlexWork): Paper | undefined {
  const title = work.display_name?.trim();
  const id = work.id ?? work.doi;
  if (!title || !id) return undefined;
  const publicationTypes = [work.type_crossref, work.type].filter(Boolean) as string[];
  const paper: Paper = {
    source: "openalex",
    sourceId: id,
    title,
    authors: work.authorships?.map((item) => item.author?.display_name ?? "").filter(Boolean) ?? [],
    venue: work.primary_location?.source?.display_name,
    institutions: uniqueStrings(
      work.authorships?.flatMap((item) => item.institutions?.map((institution) => institution.display_name ?? "") ?? []) ?? []
    ).slice(0, 3),
    year: work.publication_year,
    doi: work.doi?.replace(/^https:\/\/doi.org\//, ""),
    url: work.primary_location?.landing_page_url ?? work.id ?? "",
    abstract: abstractFromInvertedIndex(work.abstract_inverted_index),
    publicationTypes,
    citationCount: work.cited_by_count,
    evidenceLevel: "unknown",
    raw: work
  };
  paper.evidenceLevel = inferEvidenceLevel(publicationTypes, paper.source);
  return paper;
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const normalized = value.trim();
    const key = normalized.toLowerCase();
    if (!normalized || seen.has(key)) continue;
    seen.add(key);
    result.push(normalized);
  }
  return result;
}

function abstractFromInvertedIndex(index: Record<string, number[]> | undefined): string | undefined {
  if (!index) return undefined;
  const words: Array<[number, string]> = [];
  for (const [word, positions] of Object.entries(index)) {
    for (const position of positions) words.push([position, word]);
  }
  return words
    .sort(([a], [b]) => a - b)
    .map(([, word]) => word)
    .join(" ");
}
