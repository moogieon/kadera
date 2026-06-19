import type { Paper } from "../types.js";

interface ItemListResponse {
  Result?: {
    Items?: {
      Item?: MyHealthfinderTopic[];
    };
  };
}

interface MyHealthfinderTopic {
  Id?: string | number;
  Title?: string;
  AccessibleVersion?: string;
  Categories?: string;
  LastUpdate?: string;
}

export class MyHealthfinderClient {
  constructor(private readonly fetchFn: typeof fetch = fetch) {}

  async search(query: string, limit: number): Promise<Paper[]> {
    const url = new URL("https://odphp.health.gov/myhealthfinder/api/v4/itemlist.json");
    url.searchParams.set("Type", "topic");
    url.searchParams.set("Keyword", query);

    const response = await this.fetchFn(url);
    if (!response.ok) throw new Error(`MyHealthfinder search failed: ${response.status}`);
    const json = (await response.json()) as ItemListResponse;
    return (json.Result?.Items?.Item ?? []).slice(0, limit).map(toPaper).filter((paper): paper is Paper => Boolean(paper));
  }
}

function toPaper(topic: MyHealthfinderTopic): Paper | undefined {
  if (!topic.Id || !topic.Title) return undefined;
  return {
    source: "myhealthfinder",
    sourceId: String(topic.Id),
    title: topic.Title,
    authors: ["Office of Disease Prevention and Health Promotion"],
    year: topic.LastUpdate ? Number(topic.LastUpdate.slice(0, 4)) : undefined,
    url: topic.AccessibleVersion ?? `https://odphp.health.gov/myhealthfinder/api/v4/topicsearch.json?TopicId=${topic.Id}`,
    abstract: topic.Categories,
    publicationTypes: ["official guidance", "consumer health"],
    evidenceLevel: "official_guidance",
    raw: topic
  };
}
