// One server that stands between the trial's client and the free models.
// It listens on a port the system picks, registers that port and its
// catalog with the trial env, and answers every prompt with a real
// completion dialled through the gateway. A prompt is served by the best
// model that meets its needs; a model that refuses is never dialled again
// in the same trial, and the next best takes its place, up to five tries.
// Every choice comes from the brief, the request, or a gateway answer:
// nothing here reads the wall clock or rolls unseeded dice, so a replay of
// the same trial leaves the same export behind.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import {
  catalogFor,
  emptyCatalog,
  needsOfChat,
  needsOfMessages,
  ranked,
  readBrief,
  type FreeModel,
  type PromptNeeds,
} from "./lib/providers.ts";
import {
  chatUpstreamBody,
  collectChatStream,
  failureCode,
  messagesReplyFrom,
  messagesStreamFromCollected,
  messagesUpstreamBody,
  openAIReplyFrom,
  rewriteChatStream,
  trailHeaderValue,
  type UpstreamFailure,
} from "./lib/wire.ts";

const UPSTREAM_TIMEOUT_MS = 20000;
const REGISTER_WAIT_MS = 500;
const REGISTER_TRIES = 40;
const WORK_WAIT_MS = 500;
const MAX_ATTEMPTS = 5;
const MAX_BODY_BYTES = 8 * 1024 * 1024;

function log(message: string): void {
  console.error(`agg ${message}`);
}

function upstreamOrigin(): string {
  const raw = process.env.OPENAI_BASE_URL ?? "https://openrouter.ai/api/v1";
  return raw.replace(/\/+$/, "");
}

function upstreamKey(): string {
  return process.env.OPENAI_API_KEY ?? "";
}

interface DialResult {
  ok: boolean;
  status: number;
  code: string;
  text: string;
}

// One call to the gateway's Chat Completions route. A refusal is returned,
// never thrown: the caller decides whether another model takes over.
async function dialOnce(body: Record<string, unknown>): Promise<DialResult> {
  let response: Response;
  try {
    response = await fetch(`${upstreamOrigin()}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${upstreamKey()}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  } catch (error) {
    const timedOut = error instanceof Error && error.name === "TimeoutError";
    return { ok: false, status: timedOut ? 504 : 502, code: timedOut ? "timeout" : "network_error", text: "" };
  }
  const text = await response.text();
  if (response.ok) return { ok: true, status: response.status, code: "", text };
  let code = "upstream_error";
  try {
    code = failureCode(JSON.parse(text));
  } catch {
    // A refusal body that is not JSON keeps the plain fallback code.
  }
  return { ok: false, status: response.status, code, text };
}

// Models that have refused a call anywhere in this trial, by dialled id.
// The set lives for the whole trial: a refusal is a fact about the trial,
// not about one prompt, so a model that said no once is skipped everywhere
// after that, until every candidate has said no and there is nowhere else
// left to try.
const refused = new Set<string>();

// The order a prompt tries its models in: the ranked list for its needs,
// minus the models that already refused, while any are left. When none are
// left, the whole ranked list comes back as a last resort: a prompt that
// has no fresh model left still deserves its five tries at the best ones.
function attemptPool(models: FreeModel[], needs: PromptNeeds): FreeModel[] {
  const ordered = ranked(models, needs);
  const fresh = ordered.filter((m) => !refused.has(m.id));
  return fresh.length > 0 ? fresh : ordered;
}

function readRequestBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, payload: unknown, trail: UpstreamFailure[]): void {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (trail.length > 0) headers["x-makefun-upstream-failures"] = trailHeaderValue(trail);
  res.writeHead(status, headers);
  res.end(JSON.stringify(payload));
}

function sendSse(res: ServerResponse, payload: string, trail: UpstreamFailure[]): void {
  const headers: Record<string, string> = {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  };
  if (trail.length > 0) headers["x-makefun-upstream-failures"] = trailHeaderValue(trail);
  res.writeHead(200, headers);
  res.end(payload);
}

// Serve one prompt on either wire. The dial loop walks the attempt pool in
// order, translating the request for the gateway and the answer back, until
// one model answers or the tries run out. A refusal is recorded in the
// trail the answer carries, so the failover column can see it. Giving up
// answers with a plain error on the same wire, never with a made-up
// completion: a prompt this server did not serve scores nothing, and a
// fabricated one would be worse.
async function servePrompt(
  wire: "openai" | "anthropic",
  body: Record<string, unknown>,
  models: FreeModel[],
  res: ServerResponse,
): Promise<void> {
  const needs = wire === "openai" ? needsOfChat(body) : needsOfMessages(body);
  const stream = body.stream === true;
  const pool = attemptPool(models, needs).slice(0, MAX_ATTEMPTS);
  const trail: UpstreamFailure[] = [];
  for (const candidate of pool) {
    const upstreamBody = wire === "openai"
      ? chatUpstreamBody(body, candidate.id)
      : messagesUpstreamBody(body, candidate.id);
    const attempt = await dialOnce(upstreamBody);
    if (!attempt.ok) {
      refused.add(candidate.id);
      trail.push({ status: attempt.status, code: attempt.code, model: candidate.id });
      continue;
    }
    if (wire === "openai") {
      if (stream) {
        if (!attempt.text.includes("data:")) {
          refused.add(candidate.id);
          trail.push({ status: 502, code: "bad_upstream_body", model: candidate.id });
          continue;
        }
        sendSse(res, rewriteChatStream(attempt.text, candidate.id), trail);
        return;
      }
      let upstream: unknown;
      try {
        upstream = JSON.parse(attempt.text);
      } catch {
        refused.add(candidate.id);
        trail.push({ status: 502, code: "bad_upstream_body", model: candidate.id });
        continue;
      }
      sendJson(res, 200, openAIReplyFrom(upstream, candidate.id), trail);
      return;
    }
    if (stream) {
      const collected = collectChatStream(attempt.text);
      if (!collected.text && collected.toolCalls.length === 0 && !collected.finishReason) {
        refused.add(candidate.id);
        trail.push({ status: 502, code: "bad_upstream_body", model: candidate.id });
        continue;
      }
      sendSse(res, messagesStreamFromCollected(collected, candidate.id), trail);
      return;
    }
    let upstream: unknown;
    try {
      upstream = JSON.parse(attempt.text);
    } catch {
      refused.add(candidate.id);
      trail.push({ status: 502, code: "bad_upstream_body", model: candidate.id });
      continue;
    }
    sendJson(res, 200, messagesReplyFrom(upstream, candidate.id), trail);
    return;
  }
  if (wire === "openai") {
    sendJson(res, 502, {
      error: { message: "all upstream models refused this prompt", type: "api_error", code: "upstream_error" },
    }, trail);
  } else {
    sendJson(res, 502, {
      type: "error",
      error: { type: "api_error", message: "all upstream models refused this prompt" },
    }, trail);
  }
}

// The model list on the OpenAI wire: the OpenAI list shape, one row per
// free model in the brief's own order, with a fixed creation stamp so the
// answer is identical on a live pass and its replay.
function openAIModels(models: FreeModel[]): Record<string, unknown> {
  return {
    object: "list",
    data: models.map((m) => ({ id: m.id, object: "model", created: 0, owned_by: "openrouter" })),
  };
}

// The same list on the Anthropic wire: its list shape, the same ids in the
// same order, with the same fixed creation stamp.
function anthropicModels(models: FreeModel[]): Record<string, unknown> {
  const data = models.map((m) => ({
    id: m.id,
    type: "model",
    display_name: m.displayName,
    created_at: "2026-11-15T03:30:00Z",
  }));
  return {
    data,
    has_more: false,
    first_id: data.length > 0 ? data[0].id : null,
    last_id: data.length > 0 ? data[data.length - 1].id : null,
  };
}

async function handle(req: IncomingMessage, res: ServerResponse, models: FreeModel[]): Promise<void> {
  try {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (req.method === "GET" && url.pathname === "/v1/models") {
      // The wire is the auth header: an x-api-key request gets the
      // Anthropic list, anything else the OpenAI one.
      const payload = req.headers["x-api-key"] ? anthropicModels(models) : openAIModels(models);
      sendJson(res, 200, payload, []);
      return;
    }
    if (req.method === "POST" && (url.pathname === "/v1/chat/completions" || url.pathname === "/v1/messages")) {
      let raw: string;
      try {
        raw = await readRequestBody(req);
      } catch {
        sendJson(res, 413, {
          error: { message: "request body too large", type: "invalid_request_error", code: "request_too_large" },
        }, []);
        return;
      }
      let body: unknown;
      try {
        body = JSON.parse(raw);
      } catch {
        sendJson(res, 400, {
          error: { message: "request body is not valid JSON", type: "invalid_request_error", code: "invalid_json" },
        }, []);
        return;
      }
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        sendJson(res, 400, {
          error: { message: "request body must be a JSON object", type: "invalid_request_error", code: "invalid_json" },
        }, []);
        return;
      }
      await servePrompt(url.pathname === "/v1/messages" ? "anthropic" : "openai", body as Record<string, unknown>, models, res);
      return;
    }
    sendJson(res, 404, {
      error: { message: "unknown route", type: "invalid_request_error", code: "not_found" },
    }, []);
  } catch (error) {
    log(`request failed: ${error instanceof Error ? error.message : String(error)}`);
    if (!res.headersSent) {
      sendJson(res, 500, {
        error: { message: "internal error", type: "api_error", code: "internal_error" },
      }, []);
    } else {
      try {
        res.end();
      } catch {
        // The response is already on its way out; nothing left to do.
      }
    }
  }
}

// Tell the env where this server listens and what it serves. The env may
// still be coming up when the server starts, so a refused registration is
// retried for a while instead of ending the trial before it begins.
async function register(envUrl: string, port: number, catalog: unknown): Promise<number> {
  const origin = envUrl.replace(/\/+$/, "");
  for (let attempt = 0; attempt < REGISTER_TRIES; attempt++) {
    try {
      const response = await fetch(`${origin}/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ protocol_version: 1, port, catalog }),
        signal: AbortSignal.timeout(5000),
      });
      if (response.ok) {
        const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
        return typeof data.requests === "number" ? data.requests : 0;
      }
    } catch {
      // The env is not answering yet; wait and try again.
    }
    await new Promise((r) => setTimeout(r, REGISTER_WAIT_MS));
  }
  return 0;
}

// Poll the env until it says its work is done. A failed poll is not a
// failure of the trial, only a reason to ask again a moment later.
async function waitForDone(envUrl: string): Promise<void> {
  const origin = envUrl.replace(/\/+$/, "");
  for (;;) {
    try {
      const response = await fetch(`${origin}/work`, { signal: AbortSignal.timeout(5000) });
      if (response.ok) {
        const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
        if (data.done === true) return;
      }
    } catch {
      // Keep asking; the env answers when it is ready.
    }
    await new Promise((r) => setTimeout(r, WORK_WAIT_MS));
  }
}

function printUsage(): void {
  console.log("usage: node main.ts [--list] [--help]");
  console.log("  --list   print the registered model catalog and exit");
  console.log("  --help   print this usage and exit");
  console.log("Without flags, run the aggregator: register with the trial env,");
  console.log("answer /v1/chat/completions and /v1/messages from the free models,");
  console.log("and exit 0 once the env reports its work done.");
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const brief = readBrief(process.env.MAKEFUN_PROMPT_FILE);
  const models = brief?.models ?? [];
  const catalog = models.length > 0 ? catalogFor(models) : emptyCatalog();
  if (args.includes("--help")) {
    printUsage();
    return;
  }
  if (args.includes("--list")) {
    console.log(JSON.stringify(catalog));
    return;
  }
  const envUrl = process.env.MAKEFUN_ENV_URL;
  const server = createServer((req, res) => {
    void handle(req, res, models);
  });
  server.listen(0, "0.0.0.0", async () => {
    try {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      log(`listening on 0.0.0.0:${port} with ${models.length} free models`);
      if (!envUrl) return;
      const expected = await register(envUrl, port, catalog);
      log(`registered with the env: the trial holds ${expected} prompts`);
      await waitForDone(envUrl);
      log("the env reports its work done, exiting");
      server.close();
      process.exit(0);
    } catch (error) {
      log(`startup failed: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    }
  });
}

main().catch((error) => {
  log(`fatal: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
