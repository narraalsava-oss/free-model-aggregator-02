// Pure translations between the two client wires and the gateway's single
// Chat Completions route. Every function here is a function of its inputs
// only: no clock, no randomness, no I/O, so a replay of the same requests
// through the same gateway answers always produces the same bytes.

export interface UpstreamFailure {
  status: number;
  code: string;
  model: string | null;
}

// What one streamed Chat Completions answer amounts to once all of its
// chunks have arrived: the text, any tool calls, how it finished, and the
// usage the final chunk carried.
export interface CollectedStream {
  id: string;
  text: string;
  toolCalls: Array<{ id: string; name: string; args: string }>;
  finishReason: string | null;
  usage: { prompt: number; completion: number } | null;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

// A Chat Completions request goes upstream as it arrived, with only the
// model swapped for the one actually dialled.
export function chatUpstreamBody(body: unknown, modelId: string): Record<string, unknown> {
  const copy = clone((body ?? {}) as Record<string, unknown>);
  copy.model = modelId;
  return copy;
}

function anthropicText(blocks: unknown): string {
  if (typeof blocks === "string") return blocks;
  if (!Array.isArray(blocks)) return "";
  return blocks
    .filter((b: unknown) => b !== null && typeof b === "object" && (b as Record<string, unknown>).type === "text")
    .map((b) => String((b as Record<string, unknown>).text ?? ""))
    .join("");
}

// One Messages message becomes one or more Chat Completions messages. Text
// stays text, an image becomes an image_url part, a tool_use block becomes
// a tool_call on the assistant message, and a tool_result block becomes a
// tool message of its own, after the message that used the tool.
function anthropicMessageToChat(message: unknown): Array<Record<string, unknown>> {
  const raw = (message ?? {}) as Record<string, unknown>;
  const role = typeof raw.role === "string" ? raw.role : "user";
  const content = raw.content;
  if (typeof content === "string") return [{ role, content }];
  if (!Array.isArray(content)) return [{ role, content: "" }];
  const parts: Array<Record<string, unknown>> = [];
  const calls: Array<Record<string, unknown>> = [];
  const toolAnswers: Array<Record<string, unknown>> = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const b = block as Record<string, unknown>;
    if (b.type === "text") {
      parts.push({ type: "text", text: typeof b.text === "string" ? b.text : "" });
    } else if (b.type === "image") {
      const source = (b.source ?? {}) as Record<string, unknown>;
      if (typeof source.data === "string" && source.data) {
        parts.push({
          type: "image_url",
          image_url: {
            url: `data:${typeof source.media_type === "string" ? source.media_type : "image/png"};base64,${source.data}`,
          },
        });
      }
    } else if (b.type === "tool_use") {
      calls.push({
        id: typeof b.id === "string" ? b.id : "",
        type: "function",
        function: {
          name: typeof b.name === "string" ? b.name : "",
          arguments: JSON.stringify(b.input ?? {}),
        },
      });
    } else if (b.type === "tool_result") {
      toolAnswers.push({
        role: "tool",
        tool_call_id: typeof b.tool_use_id === "string" ? b.tool_use_id : "",
        content: typeof b.content === "string" ? b.content : JSON.stringify(b.content ?? ""),
      });
    }
  }
  const main: Record<string, unknown> = { role };
  if (parts.length === 1 && parts[0].type === "text") {
    main.content = parts[0].text;
  } else if (parts.length > 0) {
    main.content = parts;
  } else {
    main.content = "";
  }
  if (calls.length > 0) main.tool_calls = calls;
  return [main, ...toolAnswers];
}

// A Messages request becomes a Chat Completions body: the system prompt
// becomes a system message, the conversation is converted block by block,
// tools are reshaped into function definitions, and the output cap, the
// temperature and the streaming flag travel through unchanged.
export function messagesUpstreamBody(body: unknown, modelId: string): Record<string, unknown> {
  const raw = (body ?? {}) as Record<string, unknown>;
  const out: Record<string, unknown> = { model: modelId, messages: [] };
  const messages = out.messages as Array<Record<string, unknown>>;
  if (typeof raw.system === "string" && raw.system) {
    messages.push({ role: "system", content: raw.system });
  } else if (Array.isArray(raw.system)) {
    const text = anthropicText(raw.system);
    if (text) messages.push({ role: "system", content: text });
  }
  for (const message of (raw.messages as unknown[] | undefined) ?? []) {
    messages.push(...anthropicMessageToChat(message));
  }
  if (raw.max_tokens != null) out.max_tokens = raw.max_tokens;
  if (raw.temperature != null) out.temperature = raw.temperature;
  if (raw.top_p != null) out.top_p = raw.top_p;
  if (Array.isArray(raw.stop_sequences) && raw.stop_sequences.length > 0) {
    out.stop = raw.stop_sequences;
  }
  if (Array.isArray(raw.tools) && raw.tools.length > 0) {
    out.tools = (raw.tools as Array<Record<string, unknown>>).map((tool) => ({
      type: "function",
      function: {
        name: typeof tool.name === "string" ? tool.name : "",
        description: typeof tool.description === "string" ? tool.description : "",
        parameters: tool.input_schema ?? { type: "object", properties: {} },
      },
    }));
  }
  if (raw.stream === true) out.stream = true;
  return out;
}

// A Chat Completions answer goes back to its client as the provider wrote
// it, with only the model put back to the id actually dialled. The provider
// names the model without the gateway's prefix; the client must see the
// full dialled id, because the house scores the model the answer names.
export function openAIReplyFrom(upstream: unknown, modelId: string): Record<string, unknown> {
  const copy = clone((upstream ?? {}) as Record<string, unknown>);
  copy.model = modelId;
  if (!copy.usage || typeof copy.usage !== "object") {
    copy.usage = { prompt_tokens: 0, completion_tokens: 1, total_tokens: 1 };
  }
  return copy;
}

// The Messages wire's stop reasons, from a Chat Completions finish reason.
// A prompt the model answered by calling a tool stops for the tool, never
// for the text around it.
export function stopReasonFromFinish(finish: unknown, calledTools: boolean): string {
  if (calledTools) return "tool_use";
  if (finish === "length") return "max_tokens";
  if (finish === "tool_calls") return "tool_use";
  return "end_turn";
}

// A Chat Completions answer becomes a Messages answer: text becomes a text
// block, tool calls become tool_use blocks, the finish reason becomes a
// stop reason, and token usage is reshaped to the Messages names. Usage the
// provider left out falls back to a whole count, never a missing one.
export function messagesReplyFrom(upstream: unknown, modelId: string): Record<string, unknown> {
  const root = (upstream ?? {}) as Record<string, unknown>;
  const choice = ((root.choices as unknown[] | undefined) ?? [])[0] as Record<string, unknown> | undefined ?? {};
  const message = (choice.message ?? {}) as Record<string, unknown>;
  const blocks: Array<Record<string, unknown>> = [];
  if (typeof message.content === "string" && message.content) {
    blocks.push({ type: "text", text: message.content });
  }
  for (const call of (message.tool_calls as unknown[] | undefined) ?? []) {
    const c = (call ?? {}) as Record<string, unknown>;
    const fn = (c.function ?? {}) as Record<string, unknown>;
    let input: unknown = {};
    try {
      input = JSON.parse(typeof fn.arguments === "string" ? fn.arguments : "{}");
    } catch {
      input = {};
    }
    blocks.push({
      type: "tool_use",
      id: typeof c.id === "string" ? c.id : "",
      name: typeof fn.name === "string" ? fn.name : "",
      input,
    });
  }
  if (blocks.length === 0) blocks.push({ type: "text", text: "" });
  const usage = (root.usage ?? {}) as Record<string, unknown>;
  return {
    id: typeof root.id === "string" ? root.id : "msg-1",
    type: "message",
    role: "assistant",
    content: blocks,
    model: modelId,
    stop_reason: stopReasonFromFinish(choice.finish_reason, blocks.some((b) => b.type === "tool_use")),
    stop_sequence: null,
    usage: {
      input_tokens: typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : 0,
      output_tokens: typeof usage.completion_tokens === "number" ? usage.completion_tokens : 1,
    },
  };
}

// Fold a whole Chat Completions event stream into one collected answer:
// every text delta appended, every tool-call delta merged by index, the
// finish reason kept, and the usage the final chunk carried.
export function collectChatStream(sse: string): CollectedStream {
  const collected: CollectedStream = { id: "", text: "", toolCalls: [], finishReason: null, usage: null };
  for (const line of sse.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    let chunk: Record<string, unknown>;
    try {
      chunk = JSON.parse(payload) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (typeof chunk.id === "string" && !collected.id) collected.id = chunk.id;
    const choice = ((chunk.choices as unknown[] | undefined) ?? [])[0] as Record<string, unknown> | undefined ?? {};
    const delta = (choice.delta ?? {}) as Record<string, unknown>;
    if (typeof delta.content === "string") collected.text += delta.content;
    for (const call of (delta.tool_calls as unknown[] | undefined) ?? []) {
      const c = (call ?? {}) as Record<string, unknown>;
      const index = typeof c.index === "number" ? c.index : collected.toolCalls.length;
      const slot = collected.toolCalls[index] ?? { id: "", name: "", args: "" };
      if (typeof c.id === "string") slot.id = c.id;
      const fn = (c.function ?? {}) as Record<string, unknown>;
      if (typeof fn.name === "string") slot.name = fn.name;
      if (typeof fn.arguments === "string") slot.args += fn.arguments;
      collected.toolCalls[index] = slot;
    }
    if (typeof choice.finish_reason === "string") collected.finishReason = choice.finish_reason;
    const usage = chunk.usage as Record<string, unknown> | undefined;
    if (usage && typeof usage === "object") {
      collected.usage = {
        prompt: typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : 0,
        completion: typeof usage.completion_tokens === "number" ? usage.completion_tokens : 0,
      };
    }
  }
  return collected;
}

// Rewrite the model on every chunk of a Chat Completions stream, leaving
// the event framing, the deltas and the final [DONE] exactly as they came.
export function rewriteChatStream(sse: string, modelId: string): string {
  return sse
    .split("\n")
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) return line;
      const payload = trimmed.slice(5).trim();
      if (!payload || payload === "[DONE]") return line;
      try {
        const chunk = JSON.parse(payload) as Record<string, unknown>;
        chunk.model = modelId;
        return `data: ${JSON.stringify(chunk)}`;
      } catch {
        return line;
      }
    })
    .join("\n");
}

function sseEvent(name: string, data: unknown): string {
  return `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
}

// A collected Chat Completions answer, re-emitted as a Messages stream in
// the wire's own event order: the message opens, each content block opens,
// takes its deltas, and closes, then the stop reason and usage arrive and
// the message ends. The whole answer is known before the first event is
// written, so the order never depends on chunk arrival timing.
export function messagesStreamFromCollected(collected: CollectedStream, modelId: string): string {
  const inputTokens = collected.usage?.prompt ?? 0;
  let outputTokens = collected.usage?.completion ?? 0;
  const calledTools = collected.toolCalls.length > 0;
  if (outputTokens <= 0 && (collected.text || calledTools)) outputTokens = 1;
  const stopReason = stopReasonFromFinish(collected.finishReason, calledTools);
  let out = "";
  out += sseEvent("message_start", {
    type: "message_start",
    message: {
      id: collected.id || "msg-1",
      type: "message",
      role: "assistant",
      content: [],
      model: modelId,
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: inputTokens, output_tokens: 0 },
    },
  });
  out += sseEvent("content_block_start", {
    type: "content_block_start",
    index: 0,
    content_block: { type: "text", text: "" },
  });
  if (collected.text) {
    out += sseEvent("content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: collected.text },
    });
  }
  out += sseEvent("content_block_stop", { type: "content_block_stop", index: 0 });
  collected.toolCalls.forEach((call, i) => {
    const index = i + 1;
    out += sseEvent("content_block_start", {
      type: "content_block_start",
      index,
      content_block: { type: "tool_use", id: call.id, name: call.name, input: {} },
    });
    if (call.args) {
      out += sseEvent("content_block_delta", {
        type: "content_block_delta",
        index,
        delta: { type: "input_json_delta", partial_json: call.args },
      });
    }
    out += sseEvent("content_block_stop", { type: "content_block_stop", index });
  });
  out += sseEvent("message_delta", {
    type: "message_delta",
    delta: { stop_reason: stopReason, stop_sequence: null },
    usage: { output_tokens: outputTokens },
  });
  out += sseEvent("message_stop", { type: "message_stop" });
  return out;
}

// The refusal trail a served answer may carry: at most eight rows, in the
// order the calls refused, each naming its status, its code and its model.
export function trailHeaderValue(rows: UpstreamFailure[]): string {
  return JSON.stringify(rows.slice(0, 8));
}

// The code a refusal carries: the provider's own error code when it sent
// one, its error type when it did not, and a plain fallback otherwise.
export function failureCode(errorBody: unknown): string {
  const err = (errorBody as Record<string, unknown> | null)?.error as Record<string, unknown> | undefined;
  if (err && typeof err.code === "string" && err.code) return err.code;
  if (err && typeof err.type === "string" && err.type) return err.type;
  return "upstream_error";
}
