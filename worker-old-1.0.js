// worker.js — Cloudflare Workers version of longcat→OpenAI proxy
// Usage: wrangler secret put AUTH_COOKIES ; wrangler secret put API_BASEURL (optional)
// Then: wrangler deploy

// —— 配置 ——
// CF Workers 
const DEFAULT_USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Safari/605.1.15",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
];

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
};

function getRandomElement(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function getRandomDelayMs() {
  return 1000 + Math.floor(Math.random() * 2000);
}

function delay(ms) {
  return new Promise((res) => setTimeout(res, ms));
}

function parseAuthCookies(authHeader) {
  if (!authHeader) return null;
  const m = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!m) return null;
  const token = m[1].trim();
  if (["false", "null", "none"].includes(token.toLowerCase())) return null;
  return token.split(",").map((c) => c.trim()).filter(Boolean);
}

function formatMessages(messages) {
  return messages.map((m) => `${m.role}:${String(m.content ?? "")}`).join(";");
}

function mapFinishReason(r) {
  if (!r) return null;
  if (r === "stop") return "stop";
  if (r === "length") return "length";
  return null;
}

async function createSession(apiBase, cookie, ua) {
  const resp = await fetch(`${apiBase}/api/v1/session-create`, {
    method: "POST",
    headers: {
      "User-Agent": ua,
      "Content-Type": "application/json",
      "x-requested-with": "XMLHttpRequest",
      "X-Client-Language": "zh",
      "Referer": `${apiBase}/`,
      "Cookie": `passport_token_key=${cookie}`,
    },
    body: JSON.stringify({ model: "", agentId: "" }),
  });

  if (!resp.ok) throw new Error(`Session creation failed: ${resp.status}`);
  const data = await resp.json();
  if (data.code !== 0) throw new Error(`Session creation error: ${data.message}`);
  return data.data.conversationId;
}

async function deleteSession(apiBase, conversationId, cookie, ua) {
  const url = `${apiBase}/api/v1/session-delete?conversationId=${encodeURIComponent(conversationId)}`;
  const resp = await fetch(url, {
    method: "GET",
    headers: {
      "User-Agent": ua,
      "Content-Type": "application/json",
      "x-requested-with": "XMLHttpRequest",
      "X-Client-Language": "zh",
      "Referer": `${apiBase}/c/${conversationId}`,
      "Cookie": `passport_token_key=${cookie}`,
    },
  });
  if (!resp.ok) {
    console.error(`Failed to delete session ${conversationId}: ${resp.status}`);
  }
}

function scheduleDeletion(ctx, apiBase, conversationId, cookie, ua) {
  const ms = getRandomDelayMs();
  ctx.waitUntil((async () => {
    await delay(ms);
    await deleteSession(apiBase, conversationId, cookie, ua);
  })());
}

function toJSON(obj) {
  return new Response(JSON.stringify(obj), {
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

async function handleModels() {
  const now = Math.floor(Date.now() / 1000);
  return toJSON({
    object: "list",
    data: [
      { id: "LongCat", object: "model", created: now, owned_by: "longcat" },
      { id: "LongCat-Search", object: "model", created: now, owned_by: "longcat" },
    ],
  });
}

async function handleChatCompletions(request, env, ctx) {
  const API_BASE = (env.API_BASEURL && env.API_BASEURL.trim()) || "https://longcat.chat";
  const RAW_COOKIES = (env.AUTH_COOKIES && env.AUTH_COOKIES.trim()) || "";

  let body;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: { message: "Invalid JSON body" } }), {
      status: 400, headers: { "Content-Type": "application/json", ...CORS_HEADERS },
    });
  }

  const { messages, stream = false, model = "LongCat" } = body || {};
  if (!Array.isArray(messages) || messages.length === 0) {
    return new Response(JSON.stringify({ error: { message: "messages[] required" } }), {
      status: 400, headers: { "Content-Type": "application/json", ...CORS_HEADERS },
    });
  }

  // 准备 cookie 池
  const userCookies = parseAuthCookies(request.headers.get("Authorization")) || [];
  const envPool = RAW_COOKIES ? RAW_COOKIES.split(",").map(s => s.trim()).filter(Boolean) : [];
  const cookiePool = userCookies.length ? userCookies : envPool;
  if (!cookiePool.length) {
    return new Response(JSON.stringify({
      error: { message: "Missing cookies. Provide Authorization: Bearer <cookie[,cookie2...]> or set AUTH_COOKIES.", type: "authentication_error", code: "no_cookies" }
    }), { status: 401, headers: { "Content-Type": "application/json", ...CORS_HEADERS }});
  }

  const selectedCookie = getRandomElement(cookiePool);
  const userAgent = getRandomElement(DEFAULT_USER_AGENTS);

  // 创建会话
  let conversationId = null;

  try {
    conversationId = await createSession(API_BASE, selectedCookie, userAgent);

    // 发送聊天请求
    const formatted = formatMessages(messages);
    const searchEnabled = String(model || "").toLowerCase().includes("search") ? 1 : 0;

    const chatResp = await fetch(`${API_BASE}/api/v1/chat-completion`, {
      method: "POST",
      headers: {
        "User-Agent": userAgent,
        "Accept": "text/event-stream,application/json",
        "Content-Type": "application/json",
        "X-Requested-With": "XMLHttpRequest",
        "X-Client-Language": "zh",
        "Referer": `${API_BASE}/c/${conversationId}`,
        "Cookie": `passport_token_key=${selectedCookie}`,
      },
      body: JSON.stringify({
        conversationId,
        content: formatted,
        reasonEnabled: 0,
        searchEnabled,
        parentMessageId: 0,
      }),
    });

    if (!chatResp.ok) {
      const text = await chatResp.text().catch(() => "");
      return new Response(JSON.stringify({
        error: { message: `Upstream ${chatResp.status}: ${text.slice(0, 500)}`, type: "upstream_error", code: "upstream_error" }
      }), { status: chatResp.status, headers: { "Content-Type": "application/json", ...CORS_HEADERS }});
    }

    const ct = chatResp.headers.get("Content-Type") || "";
    const isSSE = ct.includes("text/event-stream");

    // 非流式：把上游 SSE 聚合成一个字符串再按 OpenAI 格式返回
    if (!stream) {
      if (isSSE) {
        const reader = chatResp.body.getReader();
        const decoder = new TextDecoder();
        let full = "";
        let buf = "";

        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buf += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
            const lines = buf.split("\n");
            buf = lines.pop() || "";
            for (const line of lines) {
              if (!line.startsWith("data:")) continue;
              const raw = line.slice(5).trim();
              if (!raw || raw === "[DONE]") continue;
              try {
                const data = JSON.parse(raw);
                const delta = data?.choices?.[0]?.delta;
                if (delta?.content) full += delta.content;
              } catch { /* ignore */ }
            }
          }
          if (buf && buf.startsWith("data:")) {
            const raw = buf.slice(5).trim();
            if (raw && raw !== "[DONE]") {
              try {
                const data = JSON.parse(raw);
                const delta = data?.choices?.[0]?.delta;
                if (delta?.content) full += delta.content;
              } catch { /* ignore */ }
            }
          }
        } finally {
          // 后台延迟删除会话
          if (conversationId) scheduleDeletion(ctx, API_BASE, conversationId, selectedCookie, userAgent);
        }

        const json = {
          id: `chatcmpl-${crypto.randomUUID()}`,
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [{
            index: 0,
            message: { role: "assistant", content: full },
            finish_reason: "stop",
          }],
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        };
        return new Response(JSON.stringify(json), {
          headers: { "Content-Type": "application/json", ...CORS_HEADERS },
        });
      } else {
        // 兜底：如果上游返回 JSON
        const j = await chatResp.json().catch(() => ({}));
        const text = j?.choices?.[0]?.message?.content ?? j?.content ?? "";
        const json = {
          id: `chatcmpl-${crypto.randomUUID()}`,
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [{
            index: 0,
            message: { role: "assistant", content: String(text) },
            finish_reason: "stop",
          }],
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        };
        // 删除会话
        if (conversationId) scheduleDeletion(ctx, API_BASE, conversationId, selectedCookie, userAgent);
        return new Response(JSON.stringify(json), {
          headers: { "Content-Type": "application/json", ...CORS_HEADERS },
        });
      }
    }

    // 流式：SSE 转译为 OpenAI 风格
    let buf = "";
    let sentRole = false;
    let deleted = false;

    const ts = new TransformStream({
      transform(chunk, controller) {
        const decoder = new TextDecoder();
        buf += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, "\n");
        const lines = buf.split("\n");
        buf = lines.pop() || "";

        for (const line of lines) {
          if (!line.startsWith("data:")) continue;
          const raw = line.slice(5).trim();

          if (!raw) continue;
          if (raw === "[DONE]") {
            controller.enqueue(encoder(`data: [DONE]\n\n`));
            if (!deleted && conversationId) {
              deleted = true;
              scheduleDeletion(ctx, API_BASE, conversationId, selectedCookie, userAgent);
            }
            continue;
          }

          let data;
          try { data = JSON.parse(raw); } catch { continue; }

          // 首块补 role（可选）
          if (!sentRole) {
            const roleChunk = {
              id: `chatcmpl-${data.id || crypto.randomUUID()}`,
              object: "chat.completion.chunk",
              created: Math.floor(Date.now() / 1000),
              model,
              choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
            };
            controller.enqueue(encoder(`data: ${JSON.stringify(roleChunk)}\n\n`));
            sentRole = true;
          }

          const delta = data?.choices?.[0]?.delta;
          if (delta?.content) {
            const contentChunk = {
              id: `chatcmpl-${data.id || crypto.randomUUID()}`,
              object: "chat.completion.chunk",
              created: Math.floor(Date.now() / 1000),
              model,
              choices: [{ index: 0, delta: { content: delta.content }, finish_reason: null }],
            };
            controller.enqueue(encoder(`data: ${JSON.stringify(contentChunk)}\n\n`));
          }

          const fr = mapFinishReason(data?.choices?.[0]?.finishReason);
          if (fr) {
            const stopChunk = {
              id: `chatcmpl-${data.id || crypto.randomUUID()}`,
              object: "chat.completion.chunk",
              created: Math.floor(Date.now() / 1000),
              model,
              choices: [{ index: 0, delta: {}, finish_reason: fr }],
            };
            controller.enqueue(encoder(`data: ${JSON.stringify(stopChunk)}\n\n`));
          }

          if (data?.lastOne === true) {
            controller.enqueue(encoder(`data: [DONE]\n\n`));
            if (!deleted && conversationId) {
              deleted = true;
              scheduleDeletion(ctx, API_BASE, conversationId, selectedCookie, userAgent);
            }
          }
        }
      },
      flush(controller) {
        if (buf && buf.startsWith("data:")) {
          // 尝试处理尾巴
          const raw = buf.slice(5).trim();
          if (raw && raw !== "[DONE]") {
            try {
              const data = JSON.parse(raw);
              const delta = data?.choices?.[0]?.delta;
              if (delta?.content) {
                const contentChunk = {
                  id: `chatcmpl-${crypto.randomUUID()}`,
                  object: "chat.completion.chunk",
                  created: Math.floor(Date.now() / 1000),
                  model,
                  choices: [{ index: 0, delta: { content: delta.content }, finish_reason: null }],
                };
                controller.enqueue(encoder(`data: ${JSON.stringify(contentChunk)}\n\n`));
              }
            } catch { /* ignore */ }
          }
        }
        controller.enqueue(encoder(`data: [DONE]\n\n`));
        if (!deleted && conversationId) {
          deleted = true;
          scheduleDeletion(ctx, API_BASE, conversationId, selectedCookie, userAgent);
        }
      },
    });

    const encoder = (s) => new TextEncoder().encode(s);

    return new Response(chatResp.body.pipeThrough(ts), {
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        "X-Accel-Buffering": "no",
        ...CORS_HEADERS,
      },
    });

  } catch (err) {
    // 出错也尝试后台删除
    if (conversationId) scheduleDeletion(ctx, API_BASE, conversationId, selectedCookie, userAgent);
    return new Response(JSON.stringify({
      error: {
        message: err instanceof Error ? err.message : "Internal server error",
        type: "internal_error",
        code: "internal_error",
      }
    }), { status: 500, headers: { "Content-Type": "application/json", ...CORS_HEADERS }});
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // 预检
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    // 健康检查
    if (url.pathname === "/" && request.method === "GET") {
      return toJSON({ ok: true, service: "longchat-openai-proxy (cf worker)" });
    }

    // 列模型
    if (url.pathname === "/v1/models" && request.method === "GET") {
      return handleModels();
    }

    // chat/completions
    if (url.pathname === "/v1/chat/completions" && request.method === "POST") {
      return handleChatCompletions(request, env, ctx);
    }

    return new Response("Not Found", { status: 404, headers: CORS_HEADERS });
  }
};
