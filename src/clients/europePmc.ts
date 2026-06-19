import type { Paper } from "../types.js";
import { inferEvidenceLevel } from "../evidence.js";

interface EuropePmcResponse {
  resultList?: {
    result?: EuropePmcWork[];
  };
}

interface EuropePmcWork {
  id?: string;
  pmid?: string;
  doi?: string;
  title?: string;
  authorString?: string;
  pubYear?: string;
  abstractText?: string;
  pubTypeList?: { pubType?: string[] | string };
  citedByCount?: number;
  source?: string;
}

export class EuropePmcClient {
  constructor(private readonly fetchFn: typeof fetch = fetch) {}

  async search(query: string, limit: number): Promise<Paper[]> {
    const url = new URL("https://www.ebi.ac.uk/europepmc/webservices/rest/search");
    url.searchParams.set("query", query);
    url.searchParams.set("format", "json");
    url.searchParams.set("resultType", "core");
    url.searchParams.set("pageSize", String(limit));

    const response = await this.fetchFn(url);
    if (!response.ok) throw new Error(`Europe PMC search failed: ${response.status}`);
    const json = (await response.json()) as EuropePmcResponse;
    return (json.resultList?.result ?? []).map(toPaper).filter((paper): paper is Paper => Boolean(paper));
  }
}

function toPaper(item: EuropePmcWork): Paper | undefined {
  if (!item.id || !item.title) return undefined;
  const publicationTypes = toArray(item.pubTypeList?.pubType);
  const paper: Paper = {
    source: "europe_pmc",
    sourceId: item.pmid ?? item.id,
    title: item.title,
    authors: item.authorString?.split(",").map((author) => author.trim()).filter(Boolean) ?? [],
    year: item.pubYear ? Number(item.pubYear) : undefined,
    doi: item.doi,
    url: item.pmid ? `https://europepmc.org/article/MED/${item.pmid}` : `https://europepmc.org/article/${item.source ?? "PMC"}/${item.id}`,
    abstract: item.abstractText,
    publicationTypes,
    citationCount: item.citedByCount,
    evidenceLevel: "unknown",
    raw: item
  };
  paper.evidenceLevel = inferEvidenceLevel(publicationTypes, paper.source);
  return paper;
}

function toArray<T>(value: T | T[] | undefined): T[] {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}
