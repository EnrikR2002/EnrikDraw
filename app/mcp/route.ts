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

  const oauth = Boolean(oauthConfig());
  const permissions = await agentScopes(request, origin);
  if (!permissions) {
    const challenge = oauth
      ? `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`
      : 'Bearer realm="EnrikDraw MCP"';
    return new Response("EnrikDraw agent authentication required.", {
      status: 401, headers: { ...noStore, "WWW-Authenticate": challenge },
    });
  }

  const server = makeMcpServer(origin, permissions, oauth);
  const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true, maxRequestBodySize: 512_000 });
  try {
    await server.connect(transport);
    const response = await transport.handleRequest(request);
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
