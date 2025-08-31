// deno

// 环境变量配置
const API_BASEURL = Deno.env.get("API_BASEURL") || "https://longcat.chat";
const AUTH_COOKIES = Deno.env.get("AUTH_COOKIES") || "Ag1,Ag2,Ag3…，可以通过AUTH_COOKIES环境变量设置，支持多个账户cookie使用英文逗号分隔，不推荐大量白嫖，有被ban的风险";

// 浏览器 UA 列表
const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Safari/605.1.15",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
];

// 获取随机元素
function getRandomElement<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

// 获取随机延迟（3-5秒）
function getRandomDelay(): number {
  return 3000 + Math.random() * 2000; // 3000ms + 0-2000ms = 3-5秒
}

// 延迟函数
function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// 解析 Authorization 头获取 cookies
function parseAuthCookies(authHeader: string | null): string[] | null {
  if (!authHeader) return null;
  
  const bearerMatch = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!bearerMatch) return null;
  
  const token = bearerMatch[1].trim();
  if (["false", "null", "none"].includes(token.toLowerCase())) {
    return null;
  }
  
  return token.split(",").map(c => c.trim()).filter(c => c);
}

// 格式化消息为 LongCat 格式
function formatMessages(messages: any[]): string {
  return messages.map(msg => `${msg.role}:${msg.content}`).join(";");
}

// 创建会话
async function createSession(cookie: string, userAgent: string): Promise<string> {
  const response = await fetch(`${API_BASEURL}/api/v1/session-create`, {
    method: "POST",
    headers: {
      "User-Agent": userAgent,
      "Content-Type": "application/json",
      "x-requested-with": "XMLHttpRequest",
      "X-Client-Language": "zh",
      "Referer": `${API_BASEURL}/`,
      "Cookie": `passport_token_key=${cookie}`
    },
    body: JSON.stringify({
      model: "",
      agentId: ""
    })
  });

  if (!response.ok) {
    throw new Error(`Session creation failed: ${response.status}`);
  }

  const data = await response.json();
  if (data.code !== 0) {
    throw new Error(`Session creation error: ${data.message}`);
  }

  return data.data.conversationId;
}

// 删除会话（带随机延迟）
async function deleteSession(conversationId: string, cookie: string, userAgent: string): Promise<void> {
  try {
    // 随机延迟3-5秒
    const delayMs = getRandomDelay();
    console.log(`Waiting ${delayMs}ms before deleting session ${conversationId}`);
    await delay(delayMs);
    
    const response = await fetch(`${API_BASEURL}/api/v1/session-delete?conversationId=${conversationId}`, {
      method: "GET",
      headers: {
        "User-Agent": userAgent,
        "Content-Type": "application/json",
        "x-requested-with": "XMLHttpRequest",
        "X-Client-Language": "zh",
        "Referer": `${API_BASEURL}/c/${conversationId}`,
        "Cookie": `passport_token_key=${cookie}`
      }
    });

    if (!response.ok) {
      console.error(`Failed to delete session: ${response.status}`);
    } else {
      console.log(`Successfully deleted session ${conversationId}`);
    }
  } catch (error) {
    console.error(`Error deleting session: ${error}`);
  }
}

// 异步删除会话（不等待）
function scheduleSessionDeletion(conversationId: string, cookie: string, userAgent: string): void {
  // 在后台执行删除，不阻塞响应
  deleteSession(conversationId, cookie, userAgent).catch(error => {
    console.error(`Background session deletion failed: ${error}`);
  });
}

// 解析 SSE 数据行
function parseSSELine(line: string): any | null {
  if (!line.startsWith("data:")) return null;
  
  const jsonStr = line.slice(5).trim();
  if (!jsonStr || jsonStr === "[DONE]") return null;
  
  try {
    return JSON.parse(jsonStr);
  } catch (e) {
    return null;
  }
}

// 处理流式响应
async function handleStreamResponse(
  response: Response,
  stream: boolean,
  model: string,
  conversationId: string,
  cookie: string,
  userAgent: string
): Promise<Response> {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  if (!stream) {
    // 非流式：收集所有内容
    let fullContent = "";
    let buffer = "";
    const reader = response.body!.getReader();
    
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || ""; // 保留最后一个可能不完整的行
        
        for (const line of lines) {
          const data = parseSSELine(line);
          if (data?.choices?.[0]?.delta?.content) {
            fullContent += data.choices[0].delta.content;
          }
        }
      }
      
      // 处理剩余的 buffer
      if (buffer) {
        const data = parseSSELine(buffer);
        if (data?.choices?.[0]?.delta?.content) {
          fullContent += data.choices[0].delta.content;
        }
      }
    } finally {
      // 在后台删除会话（带延迟）
      scheduleSessionDeletion(conversationId, cookie, userAgent);
    }

    // 返回非流式响应
    const responseData = {
      id: `chatcmpl-${crypto.randomUUID()}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: model,
      choices: [{
        index: 0,
        message: {
          role: "assistant",
          content: fullContent
        },
        finish_reason: "stop"
      }],
      usage: {
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0
      }
    };

    return new Response(JSON.stringify(responseData), {
      headers: { "Content-Type": "application/json" }
    });
  }

  // 流式响应
  let buffer = "";
  let isFirstChunk = true;
  let sessionDeleted = false;
  
  const transformStream = new TransformStream({
    async transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || ""; // 保留最后一个可能不完整的行
      
      for (const line of lines) {
        const data = parseSSELine(line);
        if (!data) continue;
        
        // 第一个块，发送角色信息
        if (isFirstChunk && data.choices?.[0]?.delta?.role) {
          const roleChunk = {
            id: `chatcmpl-${data.id || crypto.randomUUID()}`,
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model: model,
            choices: [{
              index: 0,
              delta: { role: "assistant" },
              finish_reason: null
            }]
          };
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(roleChunk)}\n\n`));
          isFirstChunk = false;
        }
        
        // 处理内容块
        if (data.choices?.[0]?.delta?.content) {
          const contentChunk = {
            id: `chatcmpl-${data.id || crypto.randomUUID()}`,
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model: model,
            choices: [{
              index: 0,
              delta: { content: data.choices[0].delta.content },
              finish_reason: null
            }]
          };
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(contentChunk)}\n\n`));
        }
        
        // 处理结束
        if (data.choices?.[0]?.finishReason === "stop") {
          const stopChunk = {
            id: `chatcmpl-${data.id || crypto.randomUUID()}`,
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model: model,
            choices: [{
              index: 0,
              delta: {},
              finish_reason: "stop"
            }]
          };
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(stopChunk)}\n\n`));
        }
        
        // 如果是最后一条消息，发送 [DONE] 并删除会话
        if (data.lastOne === true) {
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          if (!sessionDeleted) {
            sessionDeleted = true;
            // 在后台删除会话（带延迟）
            scheduleSessionDeletion(conversationId, cookie, userAgent);
          }
        }
      }
    },
    
    async flush(controller) {
      // 处理剩余的 buffer
      if (buffer) {
        const data = parseSSELine(buffer);
        if (data?.choices?.[0]?.delta?.content) {
          const contentChunk = {
            id: `chatcmpl-${crypto.randomUUID()}`,
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model: model,
            choices: [{
              index: 0,
              delta: { content: data.choices[0].delta.content },
              finish_reason: null
            }]
          };
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(contentChunk)}\n\n`));
        }
      }
      
      // 确保发送结束标记
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      
      // 如果还没删除会话，在后台删除（带延迟）
      if (!sessionDeleted) {
        sessionDeleted = true;
        scheduleSessionDeletion(conversationId, cookie, userAgent);
      }
    }
  });

  return new Response(
    response.body!.pipeThrough(transformStream),
    {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive"
      }
    }
  );
}

// 主处理函数
async function handleRequest(request: Request): Promise<Response> {
  const url = new URL(request.url);
  
  // 处理 /v1/models 请求
  if (url.pathname === "/v1/models" && request.method === "GET") {
    const modelsResponse = {
      object: "list",
      data: [
        {
          id: "LongCat",
          object: "model",
          created: Math.floor(Date.now() / 1000),
          owned_by: "longcat"
        },
        {
          id: "LongCat-Search",
          object: "model",
          created: 1753777714,
          owned_by: "longcat"
        }
      ]
    };
    
    return new Response(JSON.stringify(modelsResponse), {
      headers: { "Content-Type": "application/json" }
    });
  }

  // 处理 /v1/chat/completions 请求
  if (url.pathname === "/v1/chat/completions" && request.method === "POST") {
    let conversationId: string | null = null;
    let selectedCookie: string | null = null;
    let userAgent: string | null = null;
    
    try {
      // 解析请求体
      const body = await request.json();
      const { messages, stream = false, model = "LongCat" } = body;

      // 获取 cookie
      const authHeader = request.headers.get("Authorization");
      const userCookies = parseAuthCookies(authHeader);
      const cookiePool = userCookies || AUTH_COOKIES.split(",");
      selectedCookie = getRandomElement(cookiePool);
      
      // 获取随机 UA
      userAgent = getRandomElement(USER_AGENTS);

      // 创建会话
      conversationId = await createSession(selectedCookie, userAgent);

      // 准备聊天请求
      const formattedContent = formatMessages(messages);
      const searchEnabled = model.toLowerCase().includes("search") ? 1 : 0;

      // 发送聊天请求
      const chatResponse = await fetch(`${API_BASEURL}/api/v1/chat-completion`, {
        method: "POST",
        headers: {
          "User-Agent": userAgent,
          "Accept": "text/event-stream,application/json",
          "Content-Type": "application/json",
          "X-Requested-With": "XMLHttpRequest",
          "X-Client-Language": "zh",
          "Referer": `${API_BASEURL}/c/${conversationId}`,
          "Cookie": `passport_token_key=${selectedCookie}`
        },
        body: JSON.stringify({
          conversationId,
          content: formattedContent,
          reasonEnabled: 0,
          searchEnabled,
          parentMessageId: 0
        })
      });

      if (!chatResponse.ok) {
        throw new Error(`Chat request failed: ${chatResponse.status}`);
      }

      // 处理响应
      return await handleStreamResponse(chatResponse, stream, model, conversationId, selectedCookie, userAgent);

    } catch (error) {
      // 如果出错，也在后台尝试删除会话（带延迟）
      if (conversationId && selectedCookie && userAgent) {
        scheduleSessionDeletion(conversationId, selectedCookie, userAgent);
      }
      
      return new Response(JSON.stringify({
        error: {
          message: error instanceof Error ? error.message : "Internal server error",
          type: "internal_error",
          code: "internal_error"
        }
      }), {
        status: 500,
        headers: { "Content-Type": "application/json" }
      });
    }
  }

  // 404 for other routes
  return new Response("Not Found", { status: 404 });
}

// Deno Deploy 入口
Deno.serve(handleRequest);
