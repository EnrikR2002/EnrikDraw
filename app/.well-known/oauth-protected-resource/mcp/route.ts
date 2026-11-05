import { mcpOrigin, oauthConfig } from "@/lib/agent-auth";
import { notionConfig } from "@/lib/agent-notion";

export function GET() {
  const origin = mcpOrigin();
  const oauth = oauthConfig();
  const headers = { "Cache-Control": "no-store" };
  if (!origin || !oauth) return new Response(null, { status: 404, headers });
  return Response.json({
    resource: `${origin}/mcp`,
    resource_name: "EnrikDraw",
    authorization_servers: [oauth.issuer],
    bearer_methods_supported: ["header"],
    scopes_supported: notionConfig() ? oauth.allowed : oauth.allowed.filter((scope) => scope !== "notion:embed"),
  }, { headers });
}
