import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateHead,
} from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";

const BRAVE_WEB_SEARCH_URL = "https://api.search.brave.com/res/v1/web/search";
const MAX_RESULTS = 20;
const MAX_FIELD_LENGTH = 2_000;

const webSearchParameters = Type.Object({
  query: Type.String({ description: "The web-search query." }),
  count: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: MAX_RESULTS,
      description: `Maximum number of results to return (1-${MAX_RESULTS}; default 10).`,
    }),
  ),
  freshness: Type.Optional(
    StringEnum(["day", "week", "month", "year"] as const, {
      description: "Optional recency filter.",
    }),
  ),
});

type Freshness = "day" | "week" | "month" | "year";

interface BraveWebResult {
  title?: unknown;
  url?: unknown;
  description?: unknown;
  age?: unknown;
}

interface BraveSearchResponse {
  web?: {
    results?: BraveWebResult[];
  };
}

interface WebSearchDetails {
  query: string;
  count: number;
  freshness?: Freshness;
  resultCount: number;
  truncated: boolean;
}

const freshnessCodes: Record<Freshness, string> = {
  day: "pd",
  week: "pw",
  month: "pm",
  year: "py",
};

function text(value: unknown, fallback = ""): string {
  if (typeof value !== "string") return fallback;
  return value.replace(/\s+/g, " ").trim().slice(0, MAX_FIELD_LENGTH);
}

function formatResults(results: BraveWebResult[]): string {
  return results
    .map((result, index) => {
      const title = text(result.title, "Untitled result");
      const url = text(result.url, "URL unavailable");
      const description = text(result.description, "No description provided.");
      const age = text(result.age);
      return `${index + 1}. ${title}\n   URL: ${url}\n   ${description}${age ? `\n   Age: ${age}` : ""}`;
    })
    .join("\n\n");
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "web_search",
    label: "Web Search",
    description: `Search the public web with Brave Search. Returns up to ${MAX_RESULTS} results with titles, URLs, descriptions, and age when available. Output is limited to ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)}.`,
    promptSnippet: "Search the public web for current information and source URLs",
    promptGuidelines: [
      "Use web_search for current or external information that is not available in the local project. Cite the returned source URLs in the final answer.",
    ],
    parameters: webSearchParameters,

    async execute(_toolCallId, params, signal) {
      const apiKey = process.env.BRAVE_SEARCH_API_KEY;
      if (!apiKey) {
        throw new Error(
          "Web search is not configured: set the BRAVE_SEARCH_API_KEY environment variable and restart Pi.",
        );
      }

      const query = params.query.trim();
      if (!query) throw new Error("web_search requires a non-empty query.");

      const count = params.count ?? 10;
      const searchParams = new URLSearchParams({ q: query, count: String(count) });
      if (params.freshness) searchParams.set("freshness", freshnessCodes[params.freshness]);

      let response: Response;
      try {
        response = await fetch(`${BRAVE_WEB_SEARCH_URL}?${searchParams}`, {
          headers: {
            Accept: "application/json",
            "X-Subscription-Token": apiKey,
          },
          signal,
        });
      } catch (error) {
        if (signal?.aborted) throw error;
        throw new Error("Web search request to Brave failed. Check your network connection and try again.");
      }

      if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
          throw new Error("Brave rejected BRAVE_SEARCH_API_KEY. Check that the key is valid and has Web Search access.");
        }
        if (response.status === 429) {
          throw new Error("Brave Search rate limit reached. Wait and try the search again.");
        }
        throw new Error(`Brave Search returned HTTP ${response.status}. Try again later.`);
      }

      let payload: BraveSearchResponse;
      try {
        payload = (await response.json()) as BraveSearchResponse;
      } catch {
        throw new Error("Brave Search returned an unreadable response.");
      }

      const results = Array.isArray(payload.web?.results) ? payload.web.results.slice(0, count) : [];
      const details: WebSearchDetails = {
        query,
        count,
        freshness: params.freshness,
        resultCount: results.length,
        truncated: false,
      };

      if (results.length === 0) {
        return {
          content: [{ type: "text", text: `No web results found for: ${query}` }],
          details,
        };
      }

      const output = formatResults(results);
      const truncation = truncateHead(output, {
        maxLines: DEFAULT_MAX_LINES,
        maxBytes: DEFAULT_MAX_BYTES,
      });
      details.truncated = truncation.truncated;

      let resultText = truncation.content;
      if (truncation.truncated) {
        resultText += `\n\n[Search output truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}).]`;
      }

      return { content: [{ type: "text", text: resultText }], details };
    },
  });
}
