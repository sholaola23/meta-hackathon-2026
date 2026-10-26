// Shared helpers for the day-one spike: Meta Model API client, on-disk response cache, call ledger.
import OpenAI from "openai";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";

export const ROOT = join(import.meta.dir, "..");
export const CACHE_DIR = join(ROOT, "test-results/cache");
mkdirSync(CACHE_DIR, { recursive: true });

const apiKey = process.env.MODEL_API_KEY;
export const BASE_URL = "https://api.meta.ai/v1";
export const client = new OpenAI({ baseURL: BASE_URL, apiKey: apiKey ?? "missing" });

// Standard-mode prices from dev.meta.ai/docs/pricing-rate-limits (read 26 Oct 2026).
export const PRICES = {
  sparkInputPerM: 1.25,
  sparkCachedInputPerM: 0.15,
  sparkOutputPerM: 4.25,
  samPerImage: 2.5 / 1000,
  voicePerHour: 0.18,
};

const LEDGER = join(CACHE_DIR, "ledger.jsonl");

/** Every live (uncached) API call is appended here, so spend is counted from facts, not guesses. */
export function logCall(entry: Record<string, unknown>) {
  appendFileSync(LEDGER, JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n");
}

export function cacheKey(parts: unknown): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 24);
}

/** Return the cached value for key, or run fn once, store its result and return it. */
export async function cached<T>(kind: string, key: unknown, fn: () => Promise<T>): Promise<T> {
  const file = join(CACHE_DIR, `${kind}-${cacheKey(key)}.json`);
  if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8")) as T;
  if (!apiKey) throw new Error("MODEL_API_KEY is not set and no cached response exists");
  const value = await fn();
  writeFileSync(file, JSON.stringify(value));
  return value;
}

export function imageDataUrl(path: string): string {
  const b64 = readFileSync(path).toString("base64");
  return `data:image/jpeg;base64,${b64}`;
}

export function fileHash(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex").slice(0, 16);
}
