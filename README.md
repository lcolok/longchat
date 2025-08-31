# longchat
reverse longcat into openai
# LongCat API Proxy for Deno

一个基于 Deno 的代理服务器，将 OpenAI API 格式的请求转换为 LongCat API 的请求格式。

## 功能特性

- ✅ 支持 OpenAI 兼容的聊天补全接口
- ✅ 支持流式和非流式响应
- ✅ 多账户 Cookie 轮询机制
- ✅ 自动会话管理（创建后自动删除）
- ✅ 随机 User-Agent 轮换
- ✅ 随机延迟保护机制

## 快速开始

### 环境要求

- [Deno](https://deno.com/) 1.30.0 或更高版本

### 安装和运行

1. 克隆或下载项目文件
2. 配置环境变量（可选）
3. 运行服务：

```bash
# 直接运行
deno run --allow-net --allow-env main.ts

# 或指定端口运行
deno run --allow-net --allow-env main.ts --port=8000
```

### 环境变量配置

| 变量名 | 描述 | 默认值 |
|--------|------|--------|
| `API_BASEURL` | LongCat API 基础地址 | `https://longcat.chat` |
| `AUTH_COOKIES` | 认证 Cookie，多个使用英文逗号分隔 |复制cookie中的passport_token_key值 |

设置环境变量：

```bash
export AUTH_COOKIES="your_cookie_1,your_cookie_2"
export API_BASEURL="https://your-longcat-instance.com"
deno run --allow-net --allow-env main.ts
```

## API 使用

### 获取可用模型

```bash
curl http://localhost:8000/v1/models
```

响应示例：
```json
{
  "object": "list",
  "data": [
    {
      "id": "LongCat",
      "object": "model",
      "created": 1672531200,
      "owned_by": "longcat"
    },
    {
      "id": "LongCat-Search",
      "object": "model",
      "created": 1753777714,
      "owned_by": "longcat"
    }
  ]
}
```

### 聊天补全接口

#### 非流式请求

```bash
curl http://localhost:8000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your_cookie" \
  -d '{
    "model": "LongCat",
    "messages": [
      {"role": "user", "content": "你好，请介绍一下自己"}
    ],
    "stream": false
  }'
```

#### 流式请求

```bash
curl http://localhost:8000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your_cookie" \
  -d '{
    "model": "LongCat",
    "messages": [
      {"role": "user", "content": "你好，请介绍一下自己"}
    ],
    "stream": true
  }'
```

### 认证方式

在请求头中提供 Cookie 信息：

```http
Authorization: Bearer your_cookie_value
```

或多个 Cookie（使用逗号分隔）：

```http
Authorization: Bearer cookie1,cookie2,cookie3
```

## 部署

### 部署到 Deno Deploy

1. 将代码推送到 GitHub 仓库
2. 连接到 [Deno Deploy](https://deno.com/deploy)
3. 配置环境变量
4. 部署项目

### 其他部署方式

也可以使用 Docker 或其他支持 Deno 的平台部署：

```dockerfile
FROM denoland/deno:latest

WORKDIR /app
COPY main.ts .
RUN deno cache main.ts

CMD ["run", "--allow-net", "--allow-env", "main.ts"]
```
## 免责声明
- 本项目与LongCat官方无关
- 使用者需要自行获取Cookie并承担使用责任
- 项目仅用于学习和技术交流目的，禁止用于商业用途和滥用。
- 滥用可能导致账户无法正常使用。

## 注意事项

1. **使用限制**: 不推荐大量滥用，账户可能有被封禁的风险
2. **延迟机制**: 会话删除前会有 3-5 秒的随机延迟，避免请求过于频繁
3. **cookie获取**: 目前cookie只能登陆账号后，从cookie中获取passport_token_key，故直接与你的美团账号挂钩，滥用可能会影响账号使用
4. **Cookie 安全**: 不要公开分享你的 Cookie 信息
5. **模型支持**: 目前支持 `LongCat` 和 `LongCat-Search（可搜索美团）` 两种模型

## 开发与贡献

欢迎提交 Issue 和 Pull Request 来改进这个项目。

感[printlndarling](https://github.com/printlndarling)
提交的PR修正文件名，以及支持CF worker部署的worker.js代码
