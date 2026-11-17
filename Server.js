import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { WebSocketServer } from "ws";
import { z } from "zod";
import crypto from "node:crypto";

// Pipeline state matching the four-stage control structure, with data-integrity
// status for tiering, transfer, repair, and recurring checks.
const pipelineState = {
  stages: { 1: true, 2: true, 3: true, 4: true },
  labels: {
    inputPool: {
      status: "READY",
      expression: "&r == xora#FFFFFF",
      seed: 0xffffff,
      lastQuery: null
    },
    computeLayer: {
      status: "ACTIVE",
      model: "platonic_shapes(1, 1)",
      warp: 1.0,
      density: 16
    },
    linkingReasoning: {
      status: "ACTIVE",
      mapping: "rainbow_tables(PI)",
      phase: Math.PI
    },
    executionLayer: {
      status: "ACTIVE",
      output: "pixels(r)"
    },
    dataChecks: {
      status: "PENDING",
      lastCheckedAt: null,
      recordsChecked: 0,
      repairedRecords: 0,
      tiers: { high: 0, medium: 0, low: 0 },
      transfer: { status: "IDLE", itemCount: 0, checksum: null }
    }
  }
};

let lastTransferredResults = [];

// 1. Start WebSocket Bridge on port 8765
const wss = new WebSocketServer({ port: 8765 });

function broadcastState() {
  const payload = JSON.stringify({ type: "STATE_UPDATE", data: pipelineState });
  for (const client of wss.clients) {
    if (client.readyState === 1) {
      client.send(payload);
    }
  }
}

wss.on("connection", (ws) => {
  ws.send(JSON.stringify({ type: "STATE_UPDATE", data: pipelineState }));

  ws.on("message", (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.type === "CLIENT_SYNC" && msg.data) {
        Object.assign(pipelineState.stages, msg.data.stages || {});
        if (typeof msg.data.warp === "number") pipelineState.labels.computeLayer.warp = msg.data.warp;
        if (typeof msg.data.density === "number") pipelineState.labels.computeLayer.density = msg.data.density;
        broadcastState();
      }
    } catch {
      // Ignore malformed messages
    }
  });
});

// Helper: Convert scraped search text into a 24-bit hex seed and vector metrics
function hashResultsToVectorParams(query, results) {
  const combinedText = `${query}:${results.map((r) => r.title + r.url).join("|")}`;
  const hashHex = crypto.createHash("sha256").update(combinedText).digest("hex");

  // Extract 24-bit integer seed for &r == xora#FFFFFF
  const rawSeed = parseInt(hashHex.slice(0, 6), 16);
  const xorSeed = (rawSeed ^ 0xffffff) >>> 0;

  // Map result count to vector density (clamped between 6 and 36)
  const density = Math.min(36, Math.max(6, results.length * 4 || 12));

  // Map hash byte to inverse depth warp (-1.8 to 1.8)
  const warpByte = parseInt(hashHex.slice(6, 8), 16);
  const warp = Number((((warpByte / 255) * 3.6) - 1.8).toFixed(2));

  return { rawSeed, xorSeed, density, warp };
}

// Validate incoming records, make safe repairs to text fields, and tier records
// by completeness. Invalid or non-HTTP(S) URLs are rejected rather than sent on.
function validateAndTierResults(results) {
  const tiers = { high: 0, medium: 0, low: 0 };
  let repairedRecords = 0;
  const validResults = [];

  for (const item of results) {
    if (!item || typeof item !== "object" || typeof item.url !== "string") continue;

    let parsedUrl;
    try {
      parsedUrl = new URL(item.url.trim());
    } catch {
      continue;
    }
    if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") continue;

    let title = typeof item.title === "string" ? item.title.trim() : "";
    let snippet = typeof item.snippet === "string" ? item.snippet.trim() : "";
    if (!title) {
      title = parsedUrl.hostname;
      repairedRecords += 1;
    }
    if (!snippet) repairedRecords += 1;

    const tier = title && snippet ? "high" : title || snippet ? "medium" : "low";
    tiers[tier] += 1;
    validResults.push({ title, snippet, url: parsedUrl.toString(), tier });
  }

  return { results: validResults, tiers, repairedRecords };
}

function checksumResults(results) {
  return crypto.createHash("sha256").update(JSON.stringify(results)).digest("hex");
}

// Recurring integrity check: re-validate the last transferred batch and verify
// its checksum. It does not fetch or transmit new data.
function runDataIntegrityCheck() {
  const previousChecksum = pipelineState.labels.dataChecks.transfer.checksum;
  const checked = validateAndTierResults(lastTransferredResults);
  const checksum = checksumResults(checked.results);
  const checksumChanged = previousChecksum !== null && previousChecksum !== checksum;

  lastTransferredResults = checked.results;
  pipelineState.labels.dataChecks = {
    ...pipelineState.labels.dataChecks,
    status: checksumChanged ? "REPAIRED" : "OK",
    lastCheckedAt: new Date().toISOString(),
    recordsChecked: checked.results.length,
    repairedRecords: checked.repairedRecords,
    tiers: checked.tiers,
    transfer: {
      status: checked.results.length ? "VERIFIED" : "IDLE",
      itemCount: checked.results.length,
      checksum
    }
  };
  broadcastState();
}

// Helper: Lightweight search scraper using DuckDuckGo Instant Answer API
async function scrapeSearchEngine(query, maxResults = 8) {
  const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;
  const response = await fetch(url, {
    headers: { "User-Agent": "InverseMetaverseMCP/1.2" }
  });

  if (!response.ok) {
    throw new Error(`Search endpoint returned HTTP ${response.status}`);
  }

  const data = await response.json();
  const extracted = [];

  if (data.AbstractText && data.AbstractURL) {
    extracted.push({
      title: data.Heading || query,
      snippet: data.AbstractText,
      url: data.AbstractURL
    });
  }

  if (Array.isArray(data.RelatedTopics)) {
    for (const item of data.RelatedTopics) {
      if (extracted.length >= maxResults) break;
      if (item.Text && item.FirstURL) {
        extracted.push({
          title: item.Text.split(" - ")[0].slice(0, 80),
          snippet: item.Text,
          url: item.FirstURL
        });
      } else if (Array.isArray(item.Topics)) {
        for (const sub of item.Topics) {
          if (extracted.length >= maxResults) break;
          if (sub.Text && sub.FirstURL) {
            extracted.push({
              title: sub.Text.split(" - ")[0].slice(0, 80),
              snippet: sub.Text,
              url: sub.FirstURL
            });
          }
        }
      }
    }
  }

  return extracted;
}

// 2. Initialize MCP Server
const server = new McpServer({
  name: "inverse-metaverse-connector",
  version: "1.2.0"
});

const STAGE_MAP = {
  inputPool: 1,
  computeLayer: 2,
  linkingReasoning: 3,
  executionLayer: 4
};

// Tool 1: Toggle or configure individual pipeline stages
server.tool(
  "set_pipeline_stage",
  "Set a stage (inputPool, computeLayer, linkingReasoning, executionLayer) to READY, ACTIVE, or IDLE and stream to the browser.",
  {
    stage: z.enum(["inputPool", "computeLayer", "linkingReasoning", "executionLayer"]),
    status: z.enum(["READY", "ACTIVE", "IDLE"])
  },
  async ({ stage, status }) => {
    const stageId = STAGE_MAP[stage];
    pipelineState.stages[stageId] = status !== "IDLE";
    pipelineState.labels[stage].status = status;

    broadcastState();

    return {
      content: [
        {
          type: "text",
          text: `Streamed update to ${wss.clients.size} connected browser(s): ${stage} -> ${status}`
        }
      ]
    };
  }
);

// Tool 2: Manual vector parameter override
server.tool(
  "update_inverse_vectors",
  "Manually updates inverse depth warp, vector density, and seed in the live browser canvas over WebSockets.",
  {
    seed: z.number().int().optional().describe("Hex/integer input seed for XOR white-point filter"),
    warp: z.number().min(-2).max(2).optional().describe("Inverse perspective depth warp factor"),
    density: z.number().int().min(4).max(36).optional().describe("Number of nested Platonic vector shells")
  },
  async ({ seed, warp, density }) => {
    if (seed !== undefined) pipelineState.labels.inputPool.seed = seed;
    if (warp !== undefined) pipelineState.labels.computeLayer.warp = warp;
    if (density !== undefined) pipelineState.labels.computeLayer.density = density;

    broadcastState();

    return {
      content: [
        {
          type: "text",
          text: `Broadcasted vector parameters to ${wss.clients.size} browser(s):\n${JSON.stringify(pipelineState.labels, null, 2)}`
        }
      ]
    };
  }
);

// Tool 3: Web-Scraping AI Agent Tool
server.tool(
  "scrape_and_vectorize",
  "Scrapes live search engine results, validates and tiers records, repairs missing text fields, verifies the transfer checksum, and streams updated geometry to the browser canvas.",
  {
    query: z.string().trim().min(1).describe("Search topic or query to scrape and vectorize"),
    maxResults: z.number().int().min(1).max(15).default(8).describe("Maximum number of search results to ingest")
  },
  async ({ query, maxResults }) => {
    const scrapedResults = await scrapeSearchEngine(query, maxResults);
    const checked = validateAndTierResults(scrapedResults);
    const results = checked.results;
    const checksum = checksumResults(results);
    const { rawSeed, xorSeed, density, warp } = hashResultsToVectorParams(query, results);

    // Transfer only validated records into the in-memory processing batch.
    lastTransferredResults = results;
    pipelineState.labels.dataChecks = {
      status: "OK",
      lastCheckedAt: new Date().toISOString(),
      recordsChecked: results.length,
      repairedRecords: checked.repairedRecords,
      tiers: checked.tiers,
      transfer: {
        status: "VERIFIED",
        itemCount: results.length,
        checksum
      }
    };

    // Activate all 4 pipeline stages and apply derived parameters
    pipelineState.stages = { 1: true, 2: true, 3: true, 4: true };
    pipelineState.labels.inputPool.status = "READY";
    pipelineState.labels.inputPool.seed = xorSeed;
    pipelineState.labels.inputPool.lastQuery = query;

    pipelineState.labels.computeLayer.status = "ACTIVE";
    pipelineState.labels.computeLayer.density = density;
    pipelineState.labels.computeLayer.warp = warp;

    pipelineState.labels.linkingReasoning.status = "ACTIVE";
    pipelineState.labels.executionLayer.status = "ACTIVE";

    broadcastState();

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              query,
              resultsScraped: scrapedResults.length,
              resultsAccepted: results.length,
              dataIntegrity: pipelineState.labels.dataChecks,
              inputPoolHash: `0x${rawSeed.toString(16).toUpperCase().padStart(6, "0")}`,
              xoraWhitePointSeed: `0x${xorSeed.toString(16).toUpperCase().padStart(6, "0")}`,
              computedParameters: { density, warp },
              activeBrowserClients: wss.clients.size,
              scrapedItems: results
            },
            null,
            2
          )
        }
      ]
    };
  }
);

// Re-check data integrity every five minutes; unref so this timer does not keep
// the server process alive on its own.
const integrityCheckTimer = setInterval(runDataIntegrityCheck, 5 * 60 * 1000);
integrityCheckTimer.unref();

// Start MCP transport
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("Server error:", err);
  process.exit(1);
});
