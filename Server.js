import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { WebSocketServer } from "ws";
import { z } from "zod";
import crypto from "node:crypto";

const CICD_STAGES = Object.freeze([
  "fetch",
  "build",
  "containerization",
  "test",
  "repair",
  "removal",
  "transfer",
  "deployment",
  "audit"
]);
const MAX_REPAIR_ATTEMPTS = 2;

function createCicdState() {
  return {
    instructionPointer: 0,
    stage: CICD_STAGES[0],
    status: "READY",
    retryStage: null,
    repairAttempts: 0,
    stageStatus: Object.fromEntries(CICD_STAGES.map((stage) => [stage, "PENDING"])),
    history: []
  };
}

function advanceCicdState(state, outcome) {
  const currentStage = state.stage;
  if (state.status === "BLOCKED" || state.status === "COMPLETE") return state;

  const next = {
    ...state,
    stageStatus: { ...state.stageStatus },
    history: [...state.history, { stage: currentStage, outcome, at: new Date().toISOString() }]
  };

  if (outcome === "FAILED") {
    next.stageStatus[currentStage] = "FAILED";
    if (currentStage === "repair") {
      next.status = "BLOCKED";
      return next;
    }

    next.retryStage = currentStage;
    next.repairAttempts += 1;
    if (next.repairAttempts > MAX_REPAIR_ATTEMPTS) {
      next.status = "BLOCKED";
      return next;
    }
    next.instructionPointer = CICD_STAGES.indexOf("repair");
    next.stage = "repair";
    next.status = "READY";
    return next;
  }

  next.stageStatus[currentStage] = "SUCCEEDED";
  if (currentStage === "repair" && next.retryStage) {
    next.instructionPointer = CICD_STAGES.indexOf(next.retryStage);
    next.stage = next.retryStage;
    next.status = "READY";
    return next;
  }

  if (next.retryStage === currentStage) {
    next.retryStage = null;
    next.repairAttempts = 0;
  }

  next.instructionPointer += 1;
  if (next.instructionPointer >= CICD_STAGES.length) {
    next.instructionPointer = CICD_STAGES.length;
    next.stage = "complete";
    next.status = "COMPLETE";
    return next;
  }
  next.stage = CICD_STAGES[next.instructionPointer];
  next.status = "READY";
  return next;
}

function chunkRecords(records, maxBytes) {
  const chunks = [];
  let current = [];
  let currentBytes = 2; // JSON array delimiters

  for (const record of records) {
    const recordBytes = Buffer.byteLength(JSON.stringify(record));
    if (recordBytes + 2 > maxBytes) {
      throw new RangeError("A record exceeds the configured transfer chunk size");
    }
    const separatorBytes = current.length ? 1 : 0;
    if (current.length && currentBytes + separatorBytes + recordBytes > maxBytes) {
      chunks.push({ records: current, bytes: currentBytes });
      current = [];
      currentBytes = 2;
    }
    currentBytes += (current.length ? 1 : 0) + recordBytes;
    current.push(record);
  }
  if (current.length || chunks.length === 0) chunks.push({ records: current, bytes: currentBytes });
  return chunks;
}

// Existing four-stage browser pipeline, extended with CI/CD and data-check state.
const pipelineState = {
  stages: { 1: true, 2: true, 3: true, 4: true },
  cicd: createCicdState(),
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
let lastTransferChunks = [];

// WebSocket bridge for the existing browser pipeline.
const wss = new WebSocketServer({ port: 8765 });

function broadcastState() {
  const payload = JSON.stringify({ type: "STATE_UPDATE", data: pipelineState });
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(payload);
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
      // Ignore malformed messages without mutating pipeline state.
    }
  });
});

function hashResultsToVectorParams(query, results) {
  const combinedText = `${query}:${results.map((r) => r.title + r.url).join("|")}`;
  const hashHex = crypto.createHash("sha256").update(combinedText).digest("hex");
  const rawSeed = parseInt(hashHex.slice(0, 6), 16);
  const xorSeed = (rawSeed ^ 0xffffff) >>> 0;
  const density = Math.min(36, Math.max(6, results.length * 4 || 12));
  const warpByte = parseInt(hashHex.slice(6, 8), 16);
  const warp = Number((((warpByte / 255) * 3.6) - 1.8).toFixed(2));
  return { rawSeed, xorSeed, density, warp };
}

// Validate records, repair safe omissions, and tier records by completeness.
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
    const snippet = typeof item.snippet === "string" ? item.snippet.trim() : "";
    if (!title) {
      title = parsedUrl.hostname;
      repairedRecords += 1;
    }
    if (typeof item.snippet !== "string" || !snippet) repairedRecords += 1;

    const tier = title && snippet ? "high" : title || snippet ? "medium" : "low";
    tiers[tier] += 1;
    validResults.push({ title, snippet, url: parsedUrl.toString(), tier });
  }
  return { results: validResults, tiers, repairedRecords };
}

function checksumResults(results) {
  return crypto.createHash("sha256").update(JSON.stringify(results)).digest("hex");
}

function updateDataCheck(checked, status = "OK") {
  const checksum = checksumResults(checked.results);
  lastTransferredResults = checked.results;
  pipelineState.labels.dataChecks = {
    status,
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
  return checksum;
}

// Recurring check revalidates the in-memory batch; it performs no network or filesystem I/O.
function runDataIntegrityCheck() {
  const previousChecksum = pipelineState.labels.dataChecks.transfer.checksum;
  const checked = validateAndTierResults(lastTransferredResults);
  const checksum = checksumResults(checked.results);
  const changed = previousChecksum !== null && previousChecksum !== checksum;
  updateDataCheck(checked, changed ? "REPAIRED" : "OK");
  broadcastState();
}

async function scrapeSearchEngine(query, maxResults = 8) {
  const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;
  const response = await fetch(url, { headers: { "User-Agent": "InverseMetaverseMCP/1.2" } });
  if (!response.ok) throw new Error(`Search endpoint returned HTTP ${response.status}`);

  const data = await response.json();
  const extracted = [];
  if (data.AbstractText && data.AbstractURL) {
    extracted.push({ title: data.Heading || query, snippet: data.AbstractText, url: data.AbstractURL });
  }
  if (Array.isArray(data.RelatedTopics)) {
    for (const item of data.RelatedTopics) {
      if (extracted.length >= maxResults) break;
      if (item.Text && item.FirstURL) {
        extracted.push({ title: item.Text.split(" - ")[0].slice(0, 80), snippet: item.Text, url: item.FirstURL });
      } else if (Array.isArray(item.Topics)) {
        for (const sub of item.Topics) {
          if (extracted.length >= maxResults) break;
          if (sub.Text && sub.FirstURL) {
            extracted.push({ title: sub.Text.split(" - ")[0].slice(0, 80), snippet: sub.Text, url: sub.FirstURL });
          }
        }
      }
    }
  }
  return extracted;
}

const server = new McpServer({ name: "inverse-metaverse-connector", version: "1.3.0" });
const STAGE_MAP = { inputPool: 1, computeLayer: 2, linkingReasoning: 3, executionLayer: 4 };

server.tool(
  "set_pipeline_stage",
  "Set a browser pipeline stage to READY, ACTIVE, or IDLE and stream the state.",
  {
    stage: z.enum(["inputPool", "computeLayer", "linkingReasoning", "executionLayer"]),
    status: z.enum(["READY", "ACTIVE", "IDLE"])
  },
  async ({ stage, status }) => {
    pipelineState.stages[STAGE_MAP[stage]] = status !== "IDLE";
    pipelineState.labels[stage].status = status;
    broadcastState();
    return { content: [{ type: "text", text: `Streamed update to ${wss.clients.size} connected browser(s): ${stage} -> ${status}` }] };
  }
);

server.tool(
  "update_inverse_vectors",
  "Manually update inverse depth warp, vector density, and seed in the live browser canvas.",
  {
    seed: z.number().int().optional(),
    warp: z.number().min(-2).max(2).optional(),
    density: z.number().int().min(4).max(36).optional()
  },
  async ({ seed, warp, density }) => {
    if (seed !== undefined) pipelineState.labels.inputPool.seed = seed;
    if (warp !== undefined) pipelineState.labels.computeLayer.warp = warp;
    if (density !== undefined) pipelineState.labels.computeLayer.density = density;
    broadcastState();
    return { content: [{ type: "text", text: JSON.stringify(pipelineState.labels, null, 2) }] };
  }
);

server.tool(
  "advance_cicd_instruction_pointer",
  "Record the outcome of the current README pipeline stage. Failures route through bounded Repair retries; no commands are executed.",
  { outcome: z.enum(["SUCCEEDED", "FAILED"]) },
  async ({ outcome }) => {
    pipelineState.cicd = advanceCicdState(pipelineState.cicd, outcome);
    broadcastState();
    return { content: [{ type: "text", text: JSON.stringify(pipelineState.cicd, null, 2) }] };
  }
);

server.tool(
  "repair_data",
  "Revalidate the in-memory data batch, repair safe missing text fields, reject invalid URLs, and refresh integrity metadata.",
  {},
  async () => {
    const checked = validateAndTierResults(lastTransferredResults);
    const checksum = updateDataCheck(checked, "REPAIRED");
    broadcastState();
    return { content: [{ type: "text", text: JSON.stringify({ ...pipelineState.labels.dataChecks, checksum }, null, 2) }] };
  }
);

server.tool(
  "remove_low_tier_data",
  "Filter low-completeness records from the in-memory batch only. This tool never deletes repository or filesystem files.",
  {},
  async () => {
    const previousCount = lastTransferredResults.length;
    const retained = lastTransferredResults.filter((record) => record.tier !== "low");
    const removedRecords = previousCount - retained.length;
    const checked = validateAndTierResults(retained);
    updateDataCheck(checked, removedRecords ? "CLEANED" : "OK");
    broadcastState();
    return { content: [{ type: "text", text: JSON.stringify({ removedRecords, ...pipelineState.labels.dataChecks }, null, 2) }] };
  }
);

server.tool(
  "prepare_transfer_chunks",
  "Prepare bounded whole-record chunks in memory and return a size/checksum manifest; this does not create containers or files.",
  { maxBytes: z.number().int().min(256).max(65536).default(8192) },
  async ({ maxBytes }) => {
    try {
      lastTransferChunks = chunkRecords(lastTransferredResults, maxBytes);
    } catch (error) {
      return { isError: true, content: [{ type: "text", text: error.message }] };
    }
    const manifest = lastTransferChunks.map((chunk, index) => ({
      index,
      records: chunk.records.length,
      bytes: chunk.bytes,
      checksum: checksumResults(chunk.records)
    }));
    pipelineState.labels.dataChecks.transfer = {
      ...pipelineState.labels.dataChecks.transfer,
      status: lastTransferredResults.length ? "CHUNKED" : "IDLE",
      chunkCount: manifest.length,
      maxBytes
    };
    broadcastState();
    return { content: [{ type: "text", text: JSON.stringify({ totalRecords: lastTransferredResults.length, manifest }, null, 2) }] };
  }
);

server.tool(
  "scrape_and_vectorize",
  "Scrape search results, validate and tier records, repair safe omissions, checksum the in-memory batch, and update browser geometry.",
  {
    query: z.string().trim().min(1),
    maxResults: z.number().int().min(1).max(15).default(8)
  },
  async ({ query, maxResults }) => {
    const scrapedResults = await scrapeSearchEngine(query, maxResults);
    const checked = validateAndTierResults(scrapedResults);
    const results = checked.results;
    const checksum = updateDataCheck(checked);
    lastTransferChunks = [];
    const { rawSeed, xorSeed, density, warp } = hashResultsToVectorParams(query, results);

    // Preserve the existing four-stage browser pipeline behavior.
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
      content: [{
        type: "text",
        text: JSON.stringify({
          query,
          resultsScraped: scrapedResults.length,
          resultsAccepted: results.length,
          dataIntegrity: { ...pipelineState.labels.dataChecks, checksum },
          inputPoolHash: `0x${rawSeed.toString(16).toUpperCase().padStart(6, "0")}`,
          xoraWhitePointSeed: `0x${xorSeed.toString(16).toUpperCase().padStart(6, "0")}`,
          computedParameters: { density, warp },
          activeBrowserClients: wss.clients.size,
          scrapedItems: results
        }, null, 2)
      }]
    };
  }
);

// Revalidate the in-memory batch every five minutes; no network or filesystem I/O.
const integrityCheckTimer = setInterval(runDataIntegrityCheck, 5 * 60 * 1000);
integrityCheckTimer.unref();

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("Server error:", err);
  process.exit(1);
});
