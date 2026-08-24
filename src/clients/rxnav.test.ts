import { describe, expect, it } from "vitest";
import { RxNavClient } from "./rxnav.js";

describe("RxNavClient", () => {
  it("resolves a misspelled medicine brand to its active ingredient", async () => {
    const requestedUrls: string[] = [];
    const fetchFn: typeof fetch = async (input) => {
      const url = String(input);
      requestedUrls.push(url);
      if (url.includes("approximateTerm")) {
        return new Response(JSON.stringify({
          approximateGroup: { candidate: [{ rxcui: "2601734", name: "Mounjaro", rank: "1" }] }
        }));
      }
      if (url.includes("/2601734/related")) {
        return new Response(JSON.stringify({
          relatedGroup: {
            conceptGroup: [{
              tty: "IN",
              conceptProperties: [{ name: "tirzepatide" }]
            }]
          }
        }));
      }
      return new Response("not found", { status: 404 });
    };

    const client = new RxNavClient(fetchFn);
    await expect(client.resolveActiveIngredients(["마운자로 부작용", "Maunjaro (resolve canonical)", "Maunjaro medication"]))
      .resolves.toEqual(["tirzepatide"]);
    expect(requestedUrls.some((url) => url.includes("term=maunjaro"))).toBe(true);
  });
});
