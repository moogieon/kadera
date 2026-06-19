import type { Paper, SourceName } from "../types.js";

interface PreprintResponse {
  collection?: PreprintItem[];
}

interface PreprintItem {
  doi?: string;
  title?: string;
  authors?: string;
  date?: string;
  abstract?: string;
  server?: string;
  category?: string;
}

export class PreprintClient {
  constructor(private readonly source: "biorxiv" | "medrxiv", private readonly fetchFn: typeof fetch = fetch) {}

  async recent(limit: number): Promise<Paper[]> {
    const url = new URL(`https://api.biorxiv.org/details/${this.source}/30d/0/json`);
    const response = await this.fetchFn(url);
    if (!response.ok) throw new Error(`${this.source} recent search failed: ${response.status}`);
    const json = (await response.json()) as PreprintResponse;
    return (json.collection ?? []).slice(0, limit).map((item) => toPaper(item, this.source)).filter((paper): paper is Paper => Boolean(paper));
  }
}

function toPaper(item: PreprintItem, source: SourceName): Paper | undefined {
  if (!item.doi || !item.title) return undefined;
  return {
    source,
    sourceId: item.doi,
    title: item.title,
    authors: item.authors?.split(";").map((author) => author.trim()).filter(Boolean) ?? [],
    year: item.date ? Number(item.date.slice(0, 4)) : undefined,
    doi: item.doi,
    url: `https://doi.org/${item.doi}`,
    abstract: item.abstract,
    publicationTypes: ["preprint", item.category ?? ""].filter(Boolean),
    evidenceLevel: "preprint",
    raw: item
  };
}
