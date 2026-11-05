import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { agentScopes, mcpOrigin, oauthConfig } from "@/lib/agent-auth";
import { makeMcpServer } from "@/lib/agent-mcp";

export const runtime = "nodejs";
export const maxDuration = 60;

const noStore = { "Cache-Control": "no-store" };

export async function POST(request: Request) {
  const origin = mcpOrigin();
  if (!origin) return new Response(null, { status: 404, headers: noStore });
  const requestOrigin = request.headers.get("Origin");
  if (requestOrigin && requestOrigin !== origin) return new Response(null, { status: 403, headers: noStore });

  const oauth = oauthConfig();
  const permissions = await agentScopes(request, origin);
  if (!permissions) {
    const challenge = oauth
      ? `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`
      : 'Bearer realm="EnrikDraw MCP"';
    return new Response("EnrikDraw agent authentication required.", {
      status: 401, headers: { ...noStore, "WWW-Authenticate": challenge },
    });
  }

  const server = makeMcpServer(origin, permissions, oauth?.allowed ?? null);
  const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true, maxRequestBodySize: 512_000 });
  try {
    await server.connect(transport);
    let method: string | undefined;
    const receive = transport.onmessage;
    transport.onmessage = (message, extra) => {
      if ("method" in message) {
        method = ["initialize", "notifications/initialized", "tools/list", "resources/list", "resources/templates/list", "prompts/list", "ping", "tools/call"].includes(message.method)
          ? message.method : "other";
      }
      receive?.(message, extra);
    };
    const response = await transport.handleRequest(request);
    if (response.status >= 400 || (method && method !== "tools/call")) {
      const version = request.headers.get("MCP-Protocol-Version");
      const result = response.headers.get("Content-Type")?.includes("application/json")
        ? await response.clone().json().catch(() => null) : null;
      const rpcError = typeof result?.error?.code === "number" ? result.error.code : undefined;
      const problem = typeof result?.error?.message === "string" && result.error.message.includes("Unsupported protocol version")
        ? "unsupported protocol version" : undefined;
      console.info("[enrikdraw] MCP discovery", JSON.stringify({
        method, status: response.status, version: version && /^\d{4}-\d{2}-\d{2}$/.test(version) ? version : undefined,
        negotiatedVersion: method === "initialize" ? result?.result?.protocolVersion : undefined,
        tools: method === "tools/list" && Array.isArray(result?.result?.tools) ? result.result.tools.length : undefined,
        rpcError, problem,
      }));
    }
    const headers = new Headers(response.headers);
    headers.set("Cache-Control", "no-store");
    return new Response(response.body, { status: response.status, headers });
  } finally {
    await server.close();
  }
}

// This stateless server has no notification stream or sessions to terminate.
export function GET() {
  return new Response(null, { status: 405, headers: { ...noStore, Allow: "POST" } });
}

export const DELETE = GET;
