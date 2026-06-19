import { XMLParser } from "fast-xml-parser";
import type { Paper, SourceName } from "../types.js";

interface AtomRoot {
  feed?: {
    entry?: AtomEntry | AtomEntry[];
  };
}

interface AtomEntry {
  id?: string;
  title?: string;
  summary?: string;
  published?: string;
  author?: Array<{ name?: string }> | { name?: string };
  category?: Array<{ "@_term"?: string }> | { "@_term"?: string };
}

export class ArxivClient {
  private readonly parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_" });

  constructor(private readonly fetchFn: typeof fetch = fetch, private readonly source: SourceName = "arxiv") {}

  async search(query: string, limit: number): Promise<Paper[]> {
    const url = new URL("https://export.arxiv.org/api/query");
    url.searchParams.set("search_query", query.split(/\s+/).map((term) => `all:${term}`).join(" AND "));
    url.searchParams.set("start", "0");
    url.searchParams.set("max_results", String(limit));

    const response = await this.fetchFn(url);
    if (!response.ok) throw new Error(`arXiv search failed: ${response.status}`);
    const xml = await response.text();
    const parsed = this.parser.parse(xml) as AtomRoot;
    return toArray(parsed.feed?.entry).map((entry) => this.toPaper(entry)).filter((paper): paper is Paper => Boolean(paper));
  }

  private toPaper(entry: AtomEntry): Paper | undefined {
    if (!entry.id || !entry.title) return undefined;
    return {
      source: this.source,
      sourceId: entry.id,
      title: entry.title.replace(/\s+/g, " ").trim(),
      authors: toArray(entry.author).map((author) => author.name ?? "").filter(Boolean),
      year: entry.published ? Number(entry.published.slice(0, 4)) : undefined,
      url: entry.id,
      abstract: entry.summary?.replace(/\s+/g, " ").trim(),
      publicationTypes: ["preprint", ...toArray(entry.category).map((category) => category["@_term"] ?? "").filter(Boolean)],
      evidenceLevel: "preprint",
      raw: entry
    };
  }
}

function toArray<T>(value: T | T[] | undefined): T[] {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}
