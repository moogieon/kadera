import type { Config } from "../config.js";
import { inferEvidenceLevel } from "../evidence.js";
import type { Paper } from "../types.js";

interface CrossrefResponse {
  message?: {
    items?: CrossrefWork[];
  };
}

interface CrossrefWork {
  DOI?: string;
  title?: string[];
  abstract?: string;
  author?: Array<{ given?: string; family?: string }>;
  issued?: { "date-parts"?: number[][] };
  type?: string;
  URL?: string;
  "is-referenced-by-count"?: number;
  "container-title"?: string[];
}

export class CrossrefClient {
  constructor(private readonly config: Config, private readonly fetchFn: typeof fetch = fetch) {}

  async search(query: string, limit: number, cochraneOnly = false): Promise<Paper[]> {
    const url = new URL("https://api.crossref.org/works");
    url.searchParams.set("query.bibliographic", cochraneOnly ? `${query} Cochrane Database of Systematic Reviews` : query);
    url.searchParams.set("rows", String(limit));
    if (this.config.contactEmail) url.searchParams.set("mailto", this.config.contactEmail);

    const response = await this.fetchFn(url, { headers: { "user-agent": userAgent(this.config) } });
    if (!response.ok) throw new Error(`Crossref search failed: ${response.status}`);
    const json = (await response.json()) as CrossrefResponse;
    return (json.message?.items ?? [])
      .filter((item) => !cochraneOnly || (item["container-title"] ?? []).join(" ").toLowerCase().includes("cochrane"))
      .map((item) => toPaper(item, cochraneOnly))
      .filter((paper): paper is Paper => Boolean(paper));
  }
}

function toPaper(item: CrossrefWork, cochraneOnly: boolean): Paper | undefined {
  const title = item.title?.[0]?.trim();
  const sourceId = item.DOI ?? item.URL;
  if (!title || !sourceId) return undefined;
  const publicationTypes = [item.type, ...(item["container-title"] ?? [])].filter(Boolean) as string[];
  if (cochraneOnly) publicationTypes.push("systematic review", "Cochrane");
  const paper: Paper = {
    source: cochraneOnly ? "cochrane_crossref" : "crossref",
    sourceId,
    title,
    authors:
      item.author?.map((author) => [author.given, author.family].filter(Boolean).join(" ")).filter(Boolean) ?? [],
    year: item.issued?.["date-parts"]?.[0]?.[0],
    doi: item.DOI,
    url: item.URL ?? (item.DOI ? `https://doi.org/${item.DOI}` : ""),
    abstract: stripTags(item.abstract),
    publicationTypes,
    citationCount: item["is-referenced-by-count"],
    evidenceLevel: "unknown",
    raw: item
  };
  paper.evidenceLevel = cochraneOnly ? "systematic_review" : inferEvidenceLevel(publicationTypes, paper.source);
  return paper;
}

function stripTags(value: string | undefined): string | undefined {
  return value?.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function userAgent(config: Config): string {
  return `kadera-malgo/0.1.0${config.contactEmail ? ` (mailto:${config.contactEmail})` : ""}`;
}
