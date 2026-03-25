import { handleChat } from "@/sse/handlers/chat.js";
import { initTranslators } from "open-sse/translator/index.js";

let initialized = false;

/**
 * Initialize translators once
 */
async function ensureInitialized() {
  if (!initialized) {
    await initTranslators();
    initialized = true;
    console.log("[SSE] Translators initialized for /v1/messages");
  }
}

/**
 * Handle CORS preflight
 */
export async function OPTIONS() {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "*"
    }
  });
}

/**
 * POST /v1/messages - Claude/Anthropic format
 * Auto-prefixes bare model names with "cc/" since /v1/messages
 * is only used by Anthropic SDK clients (e.g. claude-agent-sdk).
 */
export async function POST(request) {
  await ensureInitialized();

  // Clone request with model prefixed for 9Router routing
  const body = await request.json();
  if (body.model && !body.model.includes("/")) {
    body.model = `cc/${body.model}`;
  }

  // Rebuild request with modified body
  const newRequest = new Request(request.url, {
    method: request.method,
    headers: request.headers,
    body: JSON.stringify(body),
  });

  return await handleChat(newRequest);
}

