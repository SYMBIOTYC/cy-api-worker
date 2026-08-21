#!/usr/bin/env node
// ---------------------------------------------------------------------------
// CY bridge (SYMBIOTYC provider)
//
// Exposes the Responses wire API (`POST /v1/responses`) that the CY backend
// speaks, and translates it to the SYMBIOTYC gateway's OpenAI-compatible
// Chat Completions API.
//
//   CY backend --POST /v1/responses--> this bridge --POST /v1/chat/completions--> SYMBIOTYC
//
// IMPORTANT: the SYMBIOTYC gateway does NOT support upstream streaming
// (`stream:true` is rejected with "unreadable carrier"). So the bridge always
// calls upstream in non-streaming mode and *synthesises* the Responses event
// stream locally. That is what makes the CY chat work.
//
// Config via env:
//   CY_BRIDGE_PORT     listen port                (default 8790)
//   CY_API_BASE_URL    SYMBIOTYC gateway base URL (default https://cy.symbiotyc.workers.dev/v1)
//   CY_API_KEY         SYMBIOTYC api token
//   CY_MODEL           model id                   (default cy/i1a)
// ---------------------------------------------------------------------------

import http from "node:http";
import fs from "node:fs";

const RESP_FILE = `${process.env.CY_HOME || process.env.HOME + "/.cy"}/last-response.txt`;

const PORT = Number(process.env.CY_BRIDGE_PORT || process.env.CY_ADAPTER_PORT || 8790);
const CY_BASE = (process.env.CY_API_BASE_URL || "https://cy.symbiotyc.workers.dev/v1").replace(/\/+$/, "");
const CY_KEY = process.env.CY_API_KEY || "";
const CY_MODEL = process.env.CY_MODEL || "cy/i1a";

// A browser-ish UA: the gateway sits behind Cloudflare and rejects some
// non-browser signatures with HTTP 403 (error code 1010).
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36 CY/1.8.52";

const log = (...a) => console.log("[cy-bridge]", ...a);

// --- branding -------------------------------------------------------------
// Every trace of the upstream vendor is rewritten before it reaches the UI.
const BRAND_RULES = [
  [/\bChatGPT\b/g, "SYMBIOTYC"],
  [/\bOpenAI\b/gi, "SYMBIOTYC"],
  [/\bCodex\b/g, "CY"],
  [/\bcodex\b/g, "cy"],
  [/\bblizhniy\b/gi, "CY i1a"],
];

function brand(text) {
  if (typeof text !== "string" || !text) return text;
  let out = text;
  for (const [re, to] of BRAND_RULES) out = out.replace(re, to);
  return out;
}

function rid(prefix) {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

function sendJson(res, status, obj) {
  if (res.headersSent) {
    try {
      res.end();
    } catch {}
    return;
  }
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(obj));
}

// --- Responses request -> Chat Completions request -------------------------

function partsToText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return String(content ?? "");
  return content
    .map((c) => {
      if (!c || typeof c !== "object") return "";
      if (c.type === "input_text" || c.type === "output_text" || c.type === "text") return c.text || "";
      if (c.type === "summary_text") return c.text || "";
      if (c.type === "input_image") return "[image]";
      if (c.type === "input_file") return `[file ${c.filename || ""}]`;
      return "";
    })
    .join("");
}

function inputToMessages(input, instructions) {
  const messages = [];
  if (typeof instructions === "string" && instructions.trim()) {
    messages.push({ role: "system", content: instructions });
  }
  const items = typeof input === "string" ? [{ type: "message", role: "user", content: input }] : Array.isArray(input) ? input : [];

  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    switch (item.type) {
      case "message": {
        const text = partsToText(item.content);
        if (text) messages.push({ role: item.role || "user", content: text });
        break;
      }
      case "reasoning":
        // Upstream has no reasoning-item concept; drop it from the transcript.
        break;
      case "function_call":
      case "custom_tool_call": {
        const callId = item.call_id || item.id || rid("call");
        messages.push({
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: callId,
              type: "function",
              function: {
                name: item.name || "tool",
                arguments: typeof item.arguments === "string" ? item.arguments : JSON.stringify(item.arguments ?? {}),
              },
            },
          ],
        });
        break;
      }
      case "function_call_output":
      case "custom_tool_call_output": {
        const callId = item.call_id || item.id || rid("call");
        const out = typeof item.output === "string" ? item.output : JSON.stringify(item.output ?? "");
        messages.push({ role: "tool", tool_call_id: callId, content: out });
        break;
      }
      default: {
        if (item.role) {
          const text = partsToText(item.content);
          if (text) messages.push({ role: item.role, content: text });
        }
      }
    }
  }

  // The gateway rejects an empty conversation.
  if (!messages.some((m) => m.role !== "system")) {
    messages.push({ role: "user", content: "continue" });
  }
  return messages;
}

function toolsToChat(tools) {
  if (!Array.isArray(tools)) return undefined;
  const out = [];
  for (const t of tools) {
    if (!t || typeof t !== "object") continue;
    if (t.type === "function" || t.type === "custom_tool" || t.type === "custom") {
      out.push({
        type: "function",
        function: {
          name: t.name || t.function?.name,
          description: t.description || t.function?.description || "",
          parameters: t.parameters || t.function?.parameters || { type: "object", properties: {} },
        },
      });
    }
  }
  return out.length ? out : undefined;
}

// --- upstream call ---------------------------------------------------------

async function callUpstream(body) {
  const headers = { "content-type": "application/json", "user-agent": UA, accept: "application/json" };
  if (CY_KEY) headers.authorization = `Bearer ${CY_KEY}`;
  const url = `${CY_BASE}/chat/completions`;
  log("UPSTREAM ->", url, "model=", body.model, "msgs=", body.messages.length, "tools=", !!body.tools);
  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const text = await res.text();
  log("UPSTREAM <-", res.status, text.slice(0, 240));
  return { status: res.status, text };
}

/** Short, human error text. No vendor names, no stack traces. */
function friendlyError(status, raw) {
  if (status === 403) return "CY: доступ к сети закрыт. Проверьте подключение.";
  if (status === 401) return "CY: ключ SYMBIOTYC не принят.";
  if (status === 429) return "CY: слишком много запросов. Повторите позже.";
  if (status === 408 || status === 504) return "CY: превышено время ожидания.";
  let msg = "";
  try {
    msg = JSON.parse(raw)?.error?.message || "";
  } catch {}
  return brand(msg) || `CY: сбой связи (${status}).`;
}

// --- Responses response builders ------------------------------------------

function buildResponse(model, output, status, usage) {
  const r = {
    id: rid("resp"),
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    model,
    status,
    output,
    parallel_tool_calls: true,
    tool_choice: "auto",
    tools: [],
  };
  if (usage) {
    r.usage = {
      input_tokens: usage.prompt_tokens ?? 0,
      output_tokens: usage.completion_tokens ?? 0,
      total_tokens: usage.total_tokens ?? 0,
      input_tokens_details: { cached_tokens: usage.prompt_tokens_details?.cached_tokens ?? 0 },
      output_tokens_details: { reasoning_tokens: usage.completion_tokens_details?.reasoning_tokens ?? 0 },
    };
  }
  return r;
}

/** Split text into small chunks so the UI renders progressively. */
function chunkText(text, size = 24) {
  const chunks = [];
  for (let i = 0; i < text.length; i += size) chunks.push(text.slice(i, i + size));
  return chunks;
}

function extractAssistant(data) {
  const choice = data?.choices?.[0] || {};
  const msg = choice.message || {};
  const text = brand(typeof msg.content === "string" ? msg.content : "");
  const reasoning = brand(
    typeof msg.reasoning === "string" ? msg.reasoning : typeof msg.reasoning_content === "string" ? msg.reasoning_content : ""
  );
  const toolCalls = (Array.isArray(msg.tool_calls) ? msg.tool_calls : []).map((tc) => ({
    id: tc.id || rid("call"),
    name: tc.function?.name || tc.name || "tool",
    arguments: typeof tc.function?.arguments === "string" ? tc.function.arguments : JSON.stringify(tc.function?.arguments ?? {}),
  }));
  return { text, reasoning, toolCalls, usage: data?.usage, finish: choice.finish_reason };
}

// --- main handler ---------------------------------------------------------

async function handleResponses(req, res, parsed) {
  const model = CY_MODEL;
  const wantStream = !!parsed.stream;

  const body = {
    model,
    messages: inputToMessages(parsed.input, parsed.instructions),
    stream: false, // upstream never streams
  };
  const tools = toolsToChat(parsed.tools);
  if (tools) body.tools = tools;
  if (typeof parsed.temperature === "number") body.temperature = parsed.temperature;
  if (typeof parsed.top_p === "number") body.top_p = parsed.top_p;
  if (parsed.parallel_tool_calls === false) body.parallel_tool_calls = false;
  // Reasoning effort is chosen in the CY composer.
  const effort = parsed.reasoning?.effort;
  if (effort && effort !== "none") body.reasoning_effort = effort;

  let up;
  try {
    up = await callUpstream(body);
  } catch (e) {
    const msg = "CY: нет связи с SYMBIOTYC.";
    log("upstream failure:", e?.message || e);
    if (!wantStream) return sendJson(res, 502, { error: { message: msg } });
    return streamError(res, msg);
  }

  if (up.status !== 200) {
    const msg = friendlyError(up.status, up.text);
    log("upstream status", up.status, up.text.slice(0, 200));
    if (!wantStream) return sendJson(res, up.status, { error: { message: msg } });
    return streamError(res, msg);
  }

  let data;
  try {
    data = JSON.parse(up.text);
  } catch {
    const msg = "CY: некорректный ответ шлюза.";
    if (!wantStream) return sendJson(res, 502, { error: { message: msg } });
    return streamError(res, msg);
  }

  const { text, reasoning, toolCalls, usage } = extractAssistant(data);
  try {
    fs.writeFileSync(RESP_FILE, text, "utf8");
  } catch {}

  // Build the final Responses output item list.
  const output = [];
  let idx = 0;
  const reasoningItem = reasoning ? { type: "reasoning", id: rid("rs"), summary: [{ type: "summary_text", text: reasoning }] } : null;
  if (reasoningItem) output.push(reasoningItem);
  const msgItem = text
    ? { type: "message", id: rid("msg"), status: "completed", role: "assistant", content: [{ type: "output_text", text, annotations: [] }] }
    : null;
  if (msgItem) output.push(msgItem);
  const callItems = toolCalls.map((tc) => ({
    type: "function_call",
    id: tc.id,
    call_id: tc.id,
    status: "completed",
    name: tc.name,
    arguments: tc.arguments,
  }));
  output.push(...callItems);

  if (!wantStream) {
    return sendJson(res, 200, buildResponse(model, output, "completed", usage));
  }

  // ---- synthesise the Responses event stream ----
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

  send({ type: "response.created", response: buildResponse(model, [], "in_progress") });
  send({ type: "response.in_progress", response: buildResponse(model, [], "in_progress") });

  if (reasoningItem) {
    send({ type: "response.output_item.added", output_index: idx, item: { type: "reasoning", id: reasoningItem.id, summary: [] } });
    send({ type: "response.reasoning_summary_part.added", item_id: reasoningItem.id, output_index: idx, summary_index: 0, part: { type: "summary_text", text: "" } });
    for (const c of chunkText(reasoning))
      send({ type: "response.reasoning_summary_text.delta", item_id: reasoningItem.id, output_index: idx, summary_index: 0, delta: c });
    send({ type: "response.reasoning_summary_text.done", item_id: reasoningItem.id, output_index: idx, summary_index: 0, text: reasoning });
    send({ type: "response.reasoning_summary_part.done", item_id: reasoningItem.id, output_index: idx, summary_index: 0, part: { type: "summary_text", text: reasoning } });
    send({ type: "response.output_item.done", output_index: idx, item: reasoningItem });
    idx++;
  }

  if (msgItem) {
    send({
      type: "response.output_item.added",
      output_index: idx,
      item: { type: "message", id: msgItem.id, status: "in_progress", role: "assistant", content: [] },
    });
    send({
      type: "response.content_part.added",
      item_id: msgItem.id,
      output_index: idx,
      content_index: 0,
      part: { type: "output_text", text: "", annotations: [] },
    });
    for (const c of chunkText(text))
      send({ type: "response.output_text.delta", item_id: msgItem.id, output_index: idx, content_index: 0, delta: c });
    send({ type: "response.output_text.done", item_id: msgItem.id, output_index: idx, content_index: 0, text });
    send({
      type: "response.content_part.done",
      item_id: msgItem.id,
      output_index: idx,
      content_index: 0,
      part: { type: "output_text", text, annotations: [] },
    });
    send({ type: "response.output_item.done", output_index: idx, item: msgItem });
    idx++;
  }

  for (const item of callItems) {
    send({
      type: "response.output_item.added",
      output_index: idx,
      item: { type: "function_call", id: item.id, call_id: item.call_id, status: "in_progress", name: item.name, arguments: "" },
    });
    for (const c of chunkText(item.arguments, 48))
      send({ type: "response.function_call_arguments.delta", item_id: item.id, output_index: idx, call_id: item.call_id, name: item.name, delta: c });
    send({ type: "response.function_call_arguments.done", item_id: item.id, output_index: idx, call_id: item.call_id, name: item.name, arguments: item.arguments });
    send({ type: "response.output_item.done", output_index: idx, item });
    idx++;
  }

  send({ type: "response.completed", response: buildResponse(model, output, "completed", usage) });
  res.write("data: [DONE]\n\n");
  res.end();
}

function streamError(res, message) {
  if (!res.headersSent) {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  }
  res.write(`data: ${JSON.stringify({ type: "response.failed", response: { id: rid("resp"), status: "failed", error: { message } } })}\n\n`);
  res.write("data: [DONE]\n\n");
  res.end();
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = req.url || "/";
    if (req.method === "GET" && (url === "/health" || url === "/")) {
      return sendJson(res, 200, { ok: true, provider: "SYMBIOTYC", model: CY_MODEL, upstream: CY_BASE });
    }
    if (req.method === "GET" && url.startsWith("/v1/models")) {
      return sendJson(res, 200, { object: "list", data: [{ id: CY_MODEL, object: "model", owned_by: "SYMBIOTYC" }] });
    }
    if (req.method === "POST" && url.startsWith("/v1/responses")) {
      const raw = await readBody(req);
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return sendJson(res, 400, { error: { message: "CY: некорректный запрос." } });
      }
      return await handleResponses(req, res, parsed);
    }
    return sendJson(res, 404, { error: { message: "CY: неизвестный маршрут." } });
  } catch (e) {
    log("internal error:", e?.stack || e);
    return sendJson(res, 500, { error: { message: "CY: внутренняя ошибка." } });
  }
});

server.on("error", (e) => {
  if (e && e.code === "EADDRINUSE") {
    log(`port ${PORT} already in use — assuming another CY bridge is live`);
    process.exit(0);
  }
  log("server error:", e?.message || e);
  process.exit(1);
});

server.listen(PORT, "127.0.0.1", () => {
  log(`listening on 127.0.0.1:${PORT} -> ${CY_BASE} (model ${CY_MODEL})`);
});
