import { XMLParser } from "fast-xml-parser";
import type { Config } from "../config.js";
import type { Paper } from "../types.js";

interface KciRoot {
  MetaData?: {
    outputData?: {
      result?: {
        resultMsg?: unknown;
      };
      record?: KciRecord | KciRecord[];
    };
  };
}

interface KciRecord {
  journalInfo?: {
    "journal-name"?: unknown;
    "publisher-name"?: unknown;
    "pub-year"?: unknown;
  };
  articleInfo?: {
    "@_article-id"?: string;
    "article-id"?: unknown;
    "article-categories"?: unknown;
    "title-group"?: {
      "article-title"?: unknown;
    };
    "author-group"?: {
      author?: unknown;
    };
    "abstract-group"?: {
      abstract?: unknown;
    };
    doi?: unknown;
    url?: unknown;
    "citation-count"?: unknown;
  };
  articleId?: unknown;
  articleTitle?: unknown;
  author?: unknown;
  journalTitle?: unknown;
  pubYear?: unknown;
  doi?: unknown;
  url?: unknown;
  abstract?: unknown;
}

export class KciClient {
  private readonly parser = new XMLParser({ ignoreAttributes: false, textNodeName: "#text" });

  constructor(private readonly config: Config, private readonly fetchFn: typeof fetch = fetch) {}

  get enabled(): boolean {
    return Boolean(this.config.kciApiKey);
  }

  async search(query: string, limit: number): Promise<Paper[]> {
    if (!this.config.kciApiKey) throw new Error("KCI_API_KEY is required");
    const searches = await Promise.allSettled([
      this.searchByApiCode("articleSearch", query, limit),
      this.searchByApiCode("referenceSearch", query, limit)
    ]);
    const papers = searches.flatMap((result) => (result.status === "fulfilled" ? result.value : []));
    if (papers.length > 0) return papers;
    const errors = searches
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => (result.reason instanceof Error ? result.reason.message : String(result.reason)));
    if (errors.length > 0) throw new Error(`KCI search failed: ${errors.join("; ")}`);
    return [];
  }

  private async searchByApiCode(apiCode: "articleSearch" | "referenceSearch", query: string, limit: number): Promise<Paper[]> {
    if (!this.config.kciApiKey) throw new Error("KCI_API_KEY is required");
    const url = new URL("https://open.kci.go.kr/po/openapi/openApiSearch.kci");
    url.searchParams.set("apiCode", apiCode);
    url.searchParams.set("key", this.config.kciApiKey);
    url.searchParams.set("title", query);
    url.searchParams.set("displayCount", String(limit));

    const response = await this.fetchFn(url);
    if (!response.ok) throw new Error(`KCI search failed: ${response.status}`);
    const xml = await response.text();
    const parsed = this.parser.parse(xml) as KciRoot;
    const resultMsg = text(parsed.MetaData?.outputData?.result?.resultMsg);
    if (resultMsg && /등록되지 않은|오류|error/i.test(resultMsg)) throw new Error(`KCI search failed: ${resultMsg}`);
    return toArray(parsed.MetaData?.outputData?.record)
      .map((record) => toPaper(record, apiCode))
      .filter((paper): paper is Paper => Boolean(paper));
  }
}

function toPaper(record: KciRecord, apiCode: "articleSearch" | "referenceSearch"): Paper | undefined {
  const articleInfo = record.articleInfo;
  const journalInfo = record.journalInfo;
  const id =
    articleInfo?.["@_article-id"] ??
    text(articleInfo?.["article-id"]) ??
    text(record.articleId) ??
    text(articleInfo?.doi) ??
    text(record.doi) ??
    firstText(articleInfo?.["title-group"]?.["article-title"]) ??
    text(record.articleTitle);
  const title = firstText(articleInfo?.["title-group"]?.["article-title"]) ?? text(record.articleTitle);
  if (!id || !title) return undefined;
  const year = Number(text(journalInfo?.["pub-year"]) ?? text(record.pubYear));
  const doi = text(articleInfo?.doi) ?? text(record.doi);
  return {
    source: "kci",
    sourceId: id,
    title,
    authors:
      toArray(articleInfo?.["author-group"]?.author)
        .map((author) => text(author))
        .filter((author): author is string => Boolean(author)) ??
      text(record.author)?.split(";").map((author) => author.trim()).filter(Boolean) ??
      [],
    year: Number.isFinite(year) ? year : undefined,
    doi,
    url: text(articleInfo?.url) ?? text(record.url) ?? (doi ? `https://doi.org/${doi}` : "https://www.kci.go.kr/"),
    abstract: firstText(articleInfo?.["abstract-group"]?.abstract) ?? text(record.abstract),
    publicationTypes: ["KCI", apiCode, text(journalInfo?.["journal-name"]) ?? text(record.journalTitle) ?? "", text(articleInfo?.["article-categories"]) ?? ""].filter(Boolean),
    citationCount: Number(text(articleInfo?.["citation-count"])) || undefined,
    evidenceLevel: "unknown",
    raw: record
  };
}

function text(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string" || typeof value === "number") return String(value).trim();
  if (typeof value === "object" && "#text" in value) return String((value as { "#text"?: unknown })["#text"] ?? "").trim();
  return undefined;
}

function firstText(value: unknown): string | undefined {
  return toArray(value)
    .map((item) => text(item))
    .find((item) => Boolean(item));
}

function toArray<T>(value: T | T[] | undefined): T[] {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}
