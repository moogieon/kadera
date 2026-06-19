import type { Paper } from "../types.js";

interface SocrataCatalogResponse {
  results?: SocrataCatalogResult[];
}

interface SocrataCatalogResult {
  resource?: {
    id?: string;
    name?: string;
    description?: string;
    updatedAt?: string;
    columns_name?: string[];
  };
  metadata?: {
    domain?: string;
  };
  permalink?: string;
}

export class CdcClient {
  constructor(private readonly fetchFn: typeof fetch = fetch) {}

  async search(query: string, limit: number): Promise<Paper[]> {
    const url = new URL("https://api.us.socrata.com/api/catalog/v1");
    url.searchParams.set("domains", "data.cdc.gov");
    url.searchParams.set("only", "datasets");
    url.searchParams.set("limit", String(limit));
    url.searchParams.set("q", query);

    const response = await this.fetchFn(url);
    if (!response.ok) throw new Error(`CDC catalog search failed: ${response.status}`);
    const json = (await response.json()) as SocrataCatalogResponse;
    return (json.results ?? []).map(toPaper).filter((paper): paper is Paper => Boolean(paper));
  }
}

function toPaper(result: SocrataCatalogResult): Paper | undefined {
  const resource = result.resource;
  if (!resource?.id || !resource.name) return undefined;
  const year = resource.updatedAt ? Number(resource.updatedAt.slice(0, 4)) : undefined;
  return {
    source: "cdc",
    sourceId: resource.id,
    title: `CDC dataset: ${resource.name}`,
    authors: ["Centers for Disease Control and Prevention"],
    year: Number.isFinite(year) ? year : undefined,
    url: result.permalink ?? `https://data.cdc.gov/d/${resource.id}`,
    abstract: resource.description,
    publicationTypes: ["official dataset", "CDC", ...(resource.columns_name ?? []).slice(0, 10)],
    evidenceLevel: "official_guidance",
    raw: result
  };
}
