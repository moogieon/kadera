import type { Config } from "../config.js";
import { inferEvidenceLevel } from "../evidence.js";
import type { Category, Paper } from "../types.js";

interface SemanticScholarResponse {
  data?: SemanticScholarPaper[];
}

interface SemanticScholarPaper {
  paperId: string;
  title?: string;
  abstract?: string;
  year?: number;
  authors?: Array<{ name?: string }>;
  url?: string;
  externalIds?: {
    DOI?: string;
    PubMed?: string;
    ArXiv?: string;
  };
  citationCount?: number;
  publicationTypes?: string[];
  venue?: string;
}

export class SemanticScholarClient {
  constructor(private readonly config: Config, private readonly fetchFn: typeof fetch = fetch) {}

  async search(query: string, limit: number, category?: Exclude<Category, "auto">): Promise<Paper[]> {
    if (this.config.semanticScholarApiKey) {
      const recent = await this.searchRecentByYear(query, limit, category);
      if (recent.length > 0) return recent;
    }
    return this.searchOnce(query, limit, { category });
  }

  private async searchRecentByYear(query: string, limit: number, category?: Exclude<Category, "auto">): Promise<Paper[]> {
    const currentYear = new Date().getFullYear();
    const minYear = currentYear - 8;

    for (let year = currentYear; year >= minYear; year--) {
      const papers = await this.searchOnce(query, limit, { year, category });
      if (papers.length > 0) return papers;
    }

    return [];
  }

  private async searchOnce(
    query: string,
    limit: number,
    options: { year?: number; category?: Exclude<Category, "auto"> } = {}
  ): Promise<Paper[]> {
    const url = new URL("https://api.semanticscholar.org/graph/v1/paper/search");
    url.searchParams.set("query", query);
    url.searchParams.set("limit", String(limit));
    if (options.year) url.searchParams.set("year", String(options.year));
    const fieldsOfStudy = semanticFieldsOfStudy(options.category);
    if (fieldsOfStudy.length > 0) url.searchParams.set("fieldsOfStudy", fieldsOfStudy.join(","));
    url.searchParams.set(
      "fields",
      "title,abstract,year,authors,url,externalIds,citationCount,publicationTypes,venue"
    );

    const headers: HeadersInit = {};
    if (this.config.semanticScholarApiKey) {
      headers["x-api-key"] = this.config.semanticScholarApiKey;
    }

    const response = await this.fetchFn(url, { headers });
    if (!response.ok) throw new Error(`Semantic Scholar search failed: ${response.status}`);
    const json = (await response.json()) as SemanticScholarResponse;
    return (json.data ?? []).map(toPaper).filter((paper): paper is Paper => paper !== undefined);
  }
}

function semanticFieldsOfStudy(category: Exclude<Category, "auto"> | undefined): string[] {
  switch (category) {
    case "health":
    case "childcare":
    case "nutrition":
    case "exercise":
      return ["Medicine", "Biology"];
    case "psychology":
      return ["Psychology", "Medicine"];
    case "education":
      return ["Education", "Psychology"];
    default:
      return [];
  }
}

function toPaper(item: SemanticScholarPaper): Paper | undefined {
  if (!item.paperId || !item.title) return undefined;
  const publicationTypes = item.publicationTypes ?? [];
  if (item.externalIds?.ArXiv) publicationTypes.push("preprint");

  const paper: Paper = {
    source: "semantic_scholar",
    sourceId: item.paperId,
    title: item.title,
    abstract: item.abstract,
    authors: item.authors?.map((author) => author.name ?? "").filter(Boolean) ?? [],
    year: item.year,
    doi: item.externalIds?.DOI,
    url: item.url ?? `https://www.semanticscholar.org/paper/${item.paperId}`,
    publicationTypes,
    citationCount: item.citationCount,
    evidenceLevel: "unknown",
    raw: item
  };
  paper.evidenceLevel = inferEvidenceLevel(publicationTypes, paper.source);
  return paper;
}
