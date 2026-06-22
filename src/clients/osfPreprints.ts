import type { Paper } from "../types.js";

interface OsfPreprintsResponse {
  data?: OsfPreprint[];
}

interface OsfPreprint {
  id?: string;
  attributes?: {
    title?: string;
    description?: string;
    date_published?: string;
    date_created?: string;
    doi?: string | null;
    tags?: string[];
  };
  links?: {
    html?: string;
  };
  relationships?: {
    contributors?: {
      links?: {
        related?: {
          href?: string;
        };
      };
    };
  };
}

export class OsfPreprintsClient {
  constructor(private readonly fetchFn: typeof fetch = fetch) {}

  async searchPsyArxiv(query: string, limit: number): Promise<Paper[]> {
    const url = new URL("https://api.osf.io/v2/preprint_providers/psyarxiv/preprints/");
    url.searchParams.set("filter[title]", query);
    url.searchParams.set("page[size]", String(Math.max(1, Math.min(limit, 10))));

    const response = await this.fetchFn(url);
    if (!response.ok) throw new Error(`OSF PsyArXiv search failed: ${response.status}`);
    const json = (await response.json()) as OsfPreprintsResponse;
    return (json.data ?? []).map(toPaper).filter((paper): paper is Paper => Boolean(paper));
  }
}

function toPaper(item: OsfPreprint): Paper | undefined {
  const title = item.attributes?.title?.trim();
  if (!item.id || !title) return undefined;
  const publishedAt = item.attributes?.date_published ?? item.attributes?.date_created;
  return {
    source: "psyarxiv",
    sourceId: item.id,
    title,
    authors: [],
    venue: "PsyArXiv",
    publisher: "Open Science Framework",
    year: publishedAt ? Number(publishedAt.slice(0, 4)) : undefined,
    doi: item.attributes?.doi ?? undefined,
    url: item.links?.html ?? `https://osf.io/preprints/psyarxiv/${item.id}`,
    abstract: item.attributes?.description,
    publicationTypes: ["preprint", "PsyArXiv", ...(item.attributes?.tags ?? [])],
    evidenceLevel: "preprint",
    raw: item
  };
}
