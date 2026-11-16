// The trial brief is the only source of truth for which models exist and how
// good the house rates each one. This module reads that brief out of the
// prompt file, turns it into the catalog the server registers, and ranks the
// models for a prompt's needs. Nothing here touches the network, the clock,
// or any randomness: the same brief always yields the same order.

import { readFileSync } from "node:fs";

export interface FreeModel {
  id: string;
  displayName: string;
  rating: number;
  contextLength: number | null;
  tools: boolean;
  vision: boolean;
  json: boolean;
}

export interface PromptNeeds {
  json: boolean;
  tools: boolean;
  vision: boolean;
}

export interface BriefPrompt {
  id: string;
  api: string;
  stream: boolean;
  weight: number;
  requires: { json?: boolean; tools?: boolean; vision?: boolean };
}

export interface Brief {
  models: FreeModel[];
  prompts: BriefPrompt[];
}

const MODELS_MARKER = '"schema":"free-model-aggregator-02/models/v1"';
const PROMPTS_MARKER = '"schema":"free-model-aggregator-02/prompts/v1"';

// The brief is prose with two JSON documents embedded as their own lines.
// Find the line carrying the marker and parse just that line.
function pickDocument(text: string, marker: string): unknown | null {
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("{") && trimmed.includes(marker)) {
      try {
        return JSON.parse(trimmed);
      } catch {
        return null;
      }
    }
  }
  return null;
}

function asModel(row: unknown): FreeModel | null {
  if (!row || typeof row !== "object") return null;
  const raw = row as Record<string, unknown>;
  if (typeof raw.id !== "string" || raw.id.length === 0) return null;
  return {
    id: raw.id,
    displayName: typeof raw.display_name === "string" ? raw.display_name : raw.id,
    rating: typeof raw.rating_milli === "number" ? raw.rating_milli : 0,
    contextLength: typeof raw.context_length === "number" ? raw.context_length : null,
    tools: raw.tools === true,
    vision: raw.vision === true,
    json: raw.json === true,
  };
}

function asPrompt(row: unknown): BriefPrompt | null {
  if (!row || typeof row !== "object") return null;
  const raw = row as Record<string, unknown>;
  if (typeof raw.id !== "string" || raw.id.length === 0) return null;
  const requires = raw.requires && typeof raw.requires === "object"
    ? (raw.requires as BriefPrompt["requires"])
    : {};
  return {
    id: raw.id,
    api: typeof raw.api === "string" ? raw.api : "openai",
    stream: raw.stream === true,
    weight: typeof raw.weight === "number" ? raw.weight : 1,
    requires,
  };
}

export function readBrief(path: string | undefined): Brief | null {
  if (!path) return null;
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  const modelsDoc = pickDocument(text, MODELS_MARKER) as { models?: unknown[] } | null;
  const promptsDoc = pickDocument(text, PROMPTS_MARKER) as { prompts?: unknown[] } | null;
  if (!modelsDoc || !Array.isArray(modelsDoc.models)) return null;
  const models: FreeModel[] = [];
  for (const row of modelsDoc.models) {
    const model = asModel(row);
    if (model) models.push(model);
  }
  if (models.length === 0) return null;
  const prompts: BriefPrompt[] = [];
  if (promptsDoc && Array.isArray(promptsDoc.prompts)) {
    for (const row of promptsDoc.prompts) {
      const prompt = asPrompt(row);
      if (prompt) prompts.push(prompt);
    }
  }
  return { models, prompts };
}

// The catalog document the server registers with the env and prints for
// --list. Same object, same serialization, both places: the column compares
// the id sets, and the two copies must never drift apart.
export function catalogFor(models: FreeModel[]): Record<string, unknown> {
  return {
    providers: [
      {
        id: "openrouter",
        base_url: "https://openrouter.ai/api/v1",
        key_env: "OPENROUTER_API_KEY",
        wire: "openai",
        models: models.map((m) => ({
          id: m.id,
          free: true,
          context_length: m.contextLength,
        })),
      },
    ],
  };
}

// Outside a trial there is no brief to read, so the catalog is empty.
export function emptyCatalog(): Record<string, unknown> {
  return { providers: [] };
}

// The models that can serve a prompt, best first: highest house rating,
// ties broken by id so the order is the same on every run. A model that
// lacks a capability the prompt needs never appears here at all.
export function ranked(models: FreeModel[], needs: PromptNeeds): FreeModel[] {
  const fitting = models.filter((m) => {
    if (needs.json && !m.json) return false;
    if (needs.tools && !m.tools) return false;
    if (needs.vision && !m.vision) return false;
    return true;
  });
  fitting.sort((a, b) => {
    if (b.rating !== a.rating) return b.rating - a.rating;
    if (a.id < b.id) return -1;
    if (a.id > b.id) return 1;
    return 0;
  });
  return fitting;
}

// Walk a request body looking for an image part, at any depth. A prompt
// that shows the model a picture needs a model that can see one.
function mentionsImage(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(mentionsImage);
  const obj = value as Record<string, unknown>;
  if (obj.type === "image_url" || obj.type === "image") return true;
  return Object.values(obj).some(mentionsImage);
}

// What a Chat Completions request demands from its model: JSON mode from
// its response_format, tools from its tool list, vision from any image part.
export function needsOfChat(body: unknown): PromptNeeds {
  const raw = (body ?? {}) as Record<string, unknown>;
  const format = (raw.response_format as Record<string, unknown> | undefined)?.type;
  return {
    json: format === "json_object" || format === "json_schema",
    tools: Array.isArray(raw.tools) && raw.tools.length > 0,
    vision: mentionsImage(raw.messages),
  };
}

// What a Messages request demands. That wire has no JSON mode, so json is
// always false here; tools and vision are read the same way as above.
export function needsOfMessages(body: unknown): PromptNeeds {
  const raw = (body ?? {}) as Record<string, unknown>;
  return {
    json: false,
    tools: Array.isArray(raw.tools) && raw.tools.length > 0,
    vision: mentionsImage(raw.messages),
  };
}
