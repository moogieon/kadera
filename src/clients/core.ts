import type { Config } from "../config.js";
import { inferEvidenceLevel } from "../evidence.js";
import type { Paper } from "../types.js";

interface CoreResponse {
  results?: CoreWork[];
}

interface CoreWork {
  id?: number | string;
  title?: string;
  abstract?: string;
  authors?: Array<{ name?: string }> | string[];
  yearPublished?: number;
  doi?: string;
  downloadUrl?: string;
  fullTextLink?: string;
  documentType?: string;
  publisher?: string;
  journals?: Array<{ title?: string }> | string[];
  repositories?: Array<{ name?: string }> | string[];
}

export class CoreClient {
  constructor(private readonly config: Config, private readonly fetchFn: typeof fetch = fetch) {}

  get enabled(): boolean {
    return Boolean(this.config.coreApiKey);
  }

  async search(query: string, limit: number): Promise<Paper[]> {
    if (!this.config.coreApiKey) throw new Error("CORE_API_KEY is required");
    const response = await this.fetchFn("https://api.core.ac.uk/v3/search/works", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.config.coreApiKey}`
      },
      body: JSON.stringify({ q: query, limit })
    });
    if (!response.ok) throw new Error(`CORE search failed: ${response.status}`);
    const json = (await response.json()) as CoreResponse;
    return (json.results ?? []).map(toPaper).filter((paper): paper is Paper => Boolean(paper));
  }
}

function toPaper(work: CoreWork): Paper | undefined {
  if (!work.id || !work.title) return undefined;
  const publicationTypes = [work.documentType ?? "open access"].filter(Boolean);
  const paper: Paper = {
    source: "core",
    sourceId: String(work.id),
    title: work.title,
    authors: Array.isArray(work.authors)
      ? work.authors.map((author) => (typeof author === "string" ? author : author.name ?? "")).filter(Boolean)
      : [],
    venue: firstNamed(work.journals),
    publisher: work.publisher ?? firstNamed(work.repositories),
    year: work.yearPublished,
    doi: work.doi,
    // CORE can return empty strings for a link field. Treat those as absent so
    // a DOI or the CORE record remains usable in the user-facing paper list.
    url: firstNonBlank(work.fullTextLink, work.downloadUrl)
      ?? (work.doi ? `https://doi.org/${work.doi}` : `https://core.ac.uk/works/${work.id}`),
    abstract: work.abstract,
    publicationTypes,
    evidenceLevel: inferEvidenceLevel(publicationTypes, "core"),
    raw: work
  };
  return paper;
}

function firstNamed(values: Array<{ title?: string; name?: string }> | string[] | undefined): string | undefined {
  if (!Array.isArray(values)) return undefined;
  const first = values[0];
  if (!first) return undefined;
  return typeof first === "string" ? first : first.title ?? first.name;
}

function firstNonBlank(...values: Array<string | undefined>): string | undefined {
  return values.find((value) => Boolean(value?.trim()))?.trim();
}
