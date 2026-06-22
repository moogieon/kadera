import { XMLParser } from "fast-xml-parser";
import type { Config } from "../config.js";
import { inferEvidenceLevel } from "../evidence.js";
import type { Paper } from "../types.js";

interface PubMedSearchResponse {
  esearchresult?: {
    idlist?: string[];
  };
}

export class PubMedClient {
  private readonly parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    textNodeName: "#text"
  });

  constructor(private readonly config: Config, private readonly fetchFn: typeof fetch = fetch) {}

  async search(query: string, limit: number): Promise<Paper[]> {
    const ids = await this.searchIds(query, limit);
    if (ids.length === 0) return [];
    return this.fetchArticles(ids);
  }

  private async searchIds(query: string, limit: number): Promise<string[]> {
    const url = new URL("https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi");
    url.searchParams.set("db", "pubmed");
    url.searchParams.set("term", query);
    url.searchParams.set("retmode", "json");
    url.searchParams.set("retmax", String(limit));
    url.searchParams.set("sort", "relevance");
    this.addNcbiParams(url);

    const response = await this.fetchFn(url);
    if (!response.ok) throw new Error(`PubMed esearch failed: ${response.status}`);
    const json = (await response.json()) as PubMedSearchResponse;
    return json.esearchresult?.idlist ?? [];
  }

  private async fetchArticles(ids: string[]): Promise<Paper[]> {
    const url = new URL("https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi");
    url.searchParams.set("db", "pubmed");
    url.searchParams.set("id", ids.join(","));
    url.searchParams.set("retmode", "xml");
    this.addNcbiParams(url);

    const response = await this.fetchFn(url);
    if (!response.ok) throw new Error(`PubMed efetch failed: ${response.status}`);
    const xml = await response.text();
    const parsed = this.parser.parse(xml) as PubMedXmlRoot;
    const articles = toArray(parsed.PubmedArticleSet?.PubmedArticle);
    return articles.map(parseArticle).filter((paper): paper is Paper => paper !== undefined);
  }

  private addNcbiParams(url: URL): void {
    if (this.config.pubmedEmail) url.searchParams.set("email", this.config.pubmedEmail);
    if (this.config.pubmedApiKey) url.searchParams.set("api_key", this.config.pubmedApiKey);
    url.searchParams.set("tool", "kadera-malgo");
  }
}

function parseArticle(article: PubmedArticle): Paper | undefined {
  const citation = article.MedlineCitation;
  const pmid = String(readText(citation?.PMID) ?? "");
  const articleNode = citation?.Article;
  const title = normalizeText(readText(articleNode?.ArticleTitle));
  if (!pmid || !title) return undefined;

  const publicationTypes = toArray(articleNode?.PublicationTypeList?.PublicationType)
    .map((type) => normalizeText(readText(type)))
    .filter(Boolean);

  const authors = toArray(articleNode?.AuthorList?.Author)
    .map((author) => {
      const last = readText(author.LastName);
      const fore = readText(author.ForeName) ?? readText(author.Initials);
      return [fore, last].filter(Boolean).join(" ");
    })
    .filter(Boolean);
  const institutions = uniqueStrings(
    toArray(articleNode?.AuthorList?.Author)
      .flatMap((author) => toArray(author.AffiliationInfo))
      .map((affiliation) => readText(affiliation?.Affiliation))
      .filter((item): item is string => Boolean(item))
      .map(cleanAffiliation)
  ).slice(0, 3);

  const doi = toArray(article.PubmedData?.ArticleIdList?.ArticleId)
    .find((id) => id?.["@_IdType"] === "doi")?.["#text"];

  const paper: Paper = {
    source: "pubmed",
    sourceId: pmid,
    title,
    authors,
    venue: normalizeText(readText(articleNode?.Journal?.Title) ?? readText(articleNode?.Journal?.ISOAbbreviation)),
    institutions,
    year: readYear(articleNode),
    doi,
    url: `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`,
    abstract: readAbstract(articleNode?.Abstract?.AbstractText),
    publicationTypes,
    evidenceLevel: "unknown",
    raw: article
  };
  paper.evidenceLevel = inferEvidenceLevel(publicationTypes, paper.source);
  return paper;
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const normalized = value.trim();
    const key = normalized.toLowerCase();
    if (!normalized || seen.has(key)) continue;
    seen.add(key);
    result.push(normalized);
  }
  return result;
}

function cleanAffiliation(value: string | undefined): string {
  return normalizeText(value)
    .replace(/\bElectronic address:.*$/i, "")
    .replace(/\bEmail:.*$/i, "")
    .replace(/\s*,?\s*United States\.?$/i, "")
    .replace(/\s*,?\s*USA\.?$/i, "")
    .trim();
}

function readYear(articleNode: ArticleNode | undefined): number | undefined {
  const year =
    readText(articleNode?.Journal?.JournalIssue?.PubDate?.Year) ??
    readText(articleNode?.Journal?.JournalIssue?.PubDate?.MedlineDate)?.match(/\d{4}/)?.[0];
  if (!year) return undefined;
  const parsed = Number(year);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function readAbstract(value: unknown): string | undefined {
  const parts = toArray(value)
    .map((part) => normalizeText(readText(part)))
    .filter(Boolean);
  return parts.length > 0 ? parts.join(" ") : undefined;
}

function readText(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (typeof value === "object" && "#text" in value) {
    const text = (value as { "#text"?: unknown })["#text"];
    return text === undefined ? undefined : String(text);
  }
  return undefined;
}

function normalizeText(value: string | undefined): string {
  return value?.replace(/\s+/g, " ").trim() ?? "";
}

function toArray<T>(value: T | T[] | undefined | null): T[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

interface PubMedXmlRoot {
  PubmedArticleSet?: {
    PubmedArticle?: PubmedArticle | PubmedArticle[];
  };
}

interface PubmedArticle {
  MedlineCitation?: {
    PMID?: unknown;
    Article?: ArticleNode;
  };
  PubmedData?: {
    ArticleIdList?: {
      ArticleId?: Array<{ "@_IdType"?: string; "#text"?: string }> | { "@_IdType"?: string; "#text"?: string };
    };
  };
}

interface ArticleNode {
  ArticleTitle?: unknown;
  Abstract?: {
    AbstractText?: unknown;
  };
  AuthorList?: {
    Author?: Array<{
      LastName?: unknown;
      ForeName?: unknown;
      Initials?: unknown;
      AffiliationInfo?: Array<{
        Affiliation?: unknown;
      }> | {
        Affiliation?: unknown;
      };
    }> | {
      LastName?: unknown;
      ForeName?: unknown;
      Initials?: unknown;
      AffiliationInfo?: Array<{
        Affiliation?: unknown;
      }> | {
        Affiliation?: unknown;
      };
    };
  };
  Journal?: {
    Title?: unknown;
    ISOAbbreviation?: unknown;
    JournalIssue?: {
      PubDate?: {
        Year?: unknown;
        MedlineDate?: unknown;
      };
    };
  };
  PublicationTypeList?: {
    PublicationType?: unknown;
  };
}
