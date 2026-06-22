import type { Paper } from "../types.js";

interface IndicatorResponse {
  value?: Array<{
    IndicatorCode?: string;
    IndicatorName?: string;
  }>;
}

interface IndicatorDataResponse {
  value?: Array<{
    IndicatorCode?: string;
    SpatialDim?: string;
    ParentLocation?: string;
    TimeDim?: number;
    Value?: string;
    NumericValue?: number;
  }>;
}

export class WhoGhoClient {
  constructor(private readonly fetchFn: typeof fetch = fetch) {}

  async search(query: string, limit: number): Promise<Paper[]> {
    const indicator = await this.findIndicator(query);
    if (!indicator?.IndicatorCode || !indicator.IndicatorName) return [];

    const url = new URL(`https://ghoapi.azureedge.net/api/${encodeURIComponent(indicator.IndicatorCode)}`);
    url.searchParams.set("$top", String(Math.max(1, Math.min(limit, 10))));
    url.searchParams.set("$orderby", "TimeDim desc");

    const response = await this.fetchFn(url);
    if (!response.ok) throw new Error(`WHO GHO data search failed: ${response.status}`);
    const json = (await response.json()) as IndicatorDataResponse;
    const rows = json.value ?? [];
    return [
      {
        source: "who_gho",
        sourceId: indicator.IndicatorCode,
        title: `WHO GHO indicator: ${indicator.IndicatorName}`,
        authors: ["World Health Organization"],
        venue: "WHO Global Health Observatory",
        publisher: "World Health Organization",
        url: `https://ghoapi.azureedge.net/api/${indicator.IndicatorCode}`,
        abstract: rows
          .slice(0, 5)
          .map((row) => `${row.SpatialDim ?? row.ParentLocation ?? "WHO"} ${row.TimeDim ?? ""}: ${row.Value ?? row.NumericValue ?? ""}`)
          .join("; "),
        publicationTypes: ["official statistics", "WHO GHO"],
        evidenceLevel: "official_guidance",
        raw: { indicator, rows }
      }
    ];
  }

  private async findIndicator(query: string): Promise<NonNullable<IndicatorResponse["value"]>[number] | undefined> {
    const token = query.split(/\s+/).find((part) => part.length > 3) ?? query;
    const url = new URL("https://ghoapi.azureedge.net/api/Indicator");
    url.searchParams.set("$filter", `contains(IndicatorName,'${token.replace(/'/g, "''")}')`);
    url.searchParams.set("$top", "1");

    const response = await this.fetchFn(url);
    if (!response.ok) throw new Error(`WHO GHO indicator search failed: ${response.status}`);
    const json = (await response.json()) as IndicatorResponse;
    return json.value?.[0];
  }
}
