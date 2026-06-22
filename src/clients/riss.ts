import { XMLParser } from "fast-xml-parser";
import type { Config } from "../config.js";
import type { Paper } from "../types.js";

interface RissRoot {
  root?: {
    items?: {
      item?: RissItem | RissItem[];
    };
  };
}

interface RissItem {
  title?: unknown;
  author?: unknown;
  publisher?: unknown;
  pubYear?: unknown;
  link?: unknown;
  description?: unknown;
}

export class RissClient {
  private readonly parser = new XMLParser({ ignoreAttributes: false, textNodeName: "#text" });

  constructor(private readonly config: Config, private readonly fetchFn: typeof fetch = fetch) {}

  get enabled(): boolean {
    return Boolean(this.config.rissApiKey);
  }

  async search(query: string, limit: number): Promise<Paper[]> {
    if (!this.config.rissApiKey) throw new Error("RISS_API_KEY is required");
    const url = new URL("http://www.riss.kr/apicenter/apiSearchJournal.do");
    url.searchParams.set("key", this.config.rissApiKey);
    url.searchParams.set("keyword", query);
    url.searchParams.set("count", String(limit));

    const response = await this.fetchFn(url);
    if (!response.ok) throw new Error(`RISS search failed: ${response.status}`);
    const body = await response.text();
    if (/<!doctype html|<html/i.test(body)) throw new Error("RISS returned HTML; check API key and parameters");
    const parsed = this.parser.parse(body) as RissRoot;
    return toArray(parsed.root?.items?.item).map(toPaper).filter((paper): paper is Paper => Boolean(paper));
  }
}

function toPaper(item: RissItem): Paper | undefined {
  const title = text(item.title);
  if (!title) return undefined;
  const year = Number(text(item.pubYear));
  return {
    source: "riss",
    sourceId: text(item.link) ?? title,
    title,
    authors: text(item.author)?.split(";").map((author) => author.trim()).filter(Boolean) ?? [],
    publisher: text(item.publisher),
    year: Number.isFinite(year) ? year : undefined,
    url: text(item.link) ?? "https://www.riss.kr/",
    abstract: text(item.description),
    publicationTypes: ["RISS", text(item.publisher) ?? ""].filter(Boolean),
    evidenceLevel: "unknown",
    raw: item
  };
}

function text(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string" || typeof value === "number") return String(value).trim();
  if (typeof value === "object" && "#text" in value) return String((value as { "#text"?: unknown })["#text"] ?? "").trim();
  return undefined;
}

function toArray<T>(value: T | T[] | undefined): T[] {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}
