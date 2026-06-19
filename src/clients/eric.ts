import type { Paper } from "../types.js";

interface EricResponse {
  response?: {
    docs?: EricDoc[];
  };
}

interface EricDoc {
  id?: string;
  title?: string;
  author?: string[];
  description?: string;
  publicationdateyear?: string;
  peerreviewed?: string;
  url?: string;
}

export class EricClient {
  constructor(private readonly fetchFn: typeof fetch = fetch) {}

  async search(query: string, limit: number): Promise<Paper[]> {
    const url = new URL("https://api.ies.ed.gov/eric/");
    url.searchParams.set("search", query);
    url.searchParams.set("format", "json");
    url.searchParams.set("rows", String(limit));

    const response = await this.fetchFn(url);
    if (!response.ok) throw new Error(`ERIC search failed: ${response.status}`);
    const json = (await response.json()) as EricResponse;
    return (json.response?.docs ?? []).map(toPaper).filter((paper): paper is Paper => Boolean(paper));
  }
}

function toPaper(doc: EricDoc): Paper | undefined {
  if (!doc.id || !doc.title) return undefined;
  return {
    source: "eric",
    sourceId: doc.id,
    title: doc.title,
    authors: doc.author ?? [],
    year: doc.publicationdateyear ? Number(doc.publicationdateyear) : undefined,
    url: doc.url ?? `https://eric.ed.gov/?id=${doc.id}`,
    abstract: doc.description,
    publicationTypes: doc.peerreviewed === "T" ? ["peer reviewed", "education"] : ["education"],
    evidenceLevel: "unknown",
    raw: doc
  };
}
