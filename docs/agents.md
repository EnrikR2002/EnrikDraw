# Connect AI agents to EnrikDraw

EnrikDraw exposes a Streamable HTTP MCP server at `https://your-enrikdraw.example/mcp`.
Its tools use the same Supabase drawings and editor as `/manage`. Newly created
diagrams consist of normal Excalidraw shapes, lines, arrows and text. The
returned `embedUrl` opens the editable canvas in Notion and stays the same
when the drawing is renamed or edited.

## Before connecting

1. Run [the Supabase schema](../supabase/schema.sql) on the existing database.
   The script can be rerun. Apply it before deploying the app update.
2. Set `NEXT_PUBLIC_APP_URL` to the stable HTTPS origin and deploy. Use that
   same origin in all client configuration. Local testing also accepts an
   explicit `http://localhost:3000` or loopback origin.
3. Configure either a scoped agent key or OAuth. Both can run together. Keep
   `DRAWING_ACCESS_SECRET` so existing Notion links remain valid.

Set production agent and Notion credentials only on the production deployment.
Use separate credentials, an origin and a database for any connected preview.

## Codex and Claude Code

Generate a separate key per client on a trusted machine.

```sh
node -e "const c=require('node:crypto'); const k='ed_'+c.randomBytes(32).toString('base64url'); console.log('Token:',k); console.log('SHA-256:',c.createHash('sha256').update(k).digest('hex'))"
```

Store the token in your client secret store or environment. Put only its digest
and scopes in the deployment's `ENRIKDRAW_AGENT_KEYS` JSON array.

```json
[{"sha256":"REPLACE_WITH_64_HEX_CHARACTERS","scopes":["drawings:read","drawings:write"]}]
```

Add entries for other clients. Add `drawings:delete` only for clients you want
to delete whole drawings, and `notion:embed` for clients allowed to place embeds
via the Notion tool. Revoke a key by removing its digest and redeploying.

For Codex, set `ENRIKDRAW_AGENT_TOKEN` in the environment that launches Codex.
Add the server to your user `config.toml`.

```toml
[mcp_servers.enrikdraw]
url = "https://your-enrikdraw.example/mcp"
bearer_token_env_var = "ENRIKDRAW_AGENT_TOKEN"
```

For Claude Code, the MCP config reads `ENRIKDRAW_AGENT_TOKEN` from the
environment that launches Claude Code.

```json
{
  "mcpServers": {
    "enrikdraw": {
      "type": "http",
      "url": "https://your-enrikdraw.example/mcp",
      "headers": { "Authorization": "Bearer ${ENRIKDRAW_AGENT_TOKEN}" }
    }
  }
}
```

See the [Codex MCP configuration](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)
and [Claude Code MCP configuration](https://code.claude.com/docs/en/mcp).

## ChatGPT

ChatGPT's custom MCP plugin uses OAuth. Use an established OAuth authorization
server such as Auth0. EnrikDraw verifies access tokens as the resource server.

1. Register an API with identifier `https://your-enrikdraw.example/mcp`, RS256
   signing and access-token lifetime of at most one hour. Configure the allowed
   API scopes `drawings:read` and `drawings:write`. Add `drawings:delete` or
   `notion:embed` if you intend to grant those actions. Enable the provider's
   resource indicator support so ChatGPT's `resource` parameter selects this
   API. In Auth0 this setting is Resource Parameter Compatibility.
2. Register a dedicated OAuth client for ChatGPT and enable authorization code
   with PKCE S256. Use the exact callback URI shown in ChatGPT's plugin setup.
   Limit authorization to your account at the provider. Keep the provider's
   access-token `scope` claim, and its `azp` or `client_id` claim identifying
   this client.
3. Set the following server environment variables and deploy. Use the exact
   provider metadata values, including any trailing slash on the issuer.

   | Variable | Value |
   |---|---|
   | `ENRIKDRAW_OAUTH_ISSUER` | Provider's `issuer` |
   | `ENRIKDRAW_OAUTH_JWKS_URL` | Provider's `jwks_uri` |
   | `ENRIKDRAW_OAUTH_SUBJECT` | Your account's exact immutable access-token `sub`, for example `auth0\|…` |
   | `ENRIKDRAW_OAUTH_CLIENT_ID` | Dedicated ChatGPT OAuth client ID |
   | `ENRIKDRAW_OAUTH_SCOPES` | Optional space-separated permission ceiling. Defaults to `drawings:read drawings:write`. Add `drawings:delete` or `notion:embed` only if you want ChatGPT to use them. |

4. In ChatGPT on the web, go to **Plugins → Add custom MCP server**. Name it
   **EnrikDraw**, enter the `/mcp` URL, choose **OAuth**, and supply the static
   client credentials from the identity provider. ChatGPT discovers the issuer
   using `/.well-known/oauth-protected-resource/mcp`. Install the plugin, sign
   in with the allowed account, and select `@EnrikDraw` in a conversation. Your
   workspace must allow custom plugins and the relevant write tools.

See [ChatGPT's custom MCP setup](https://developers.openai.com/api/docs/guides/custom-mcp-server),
[OpenAI's OAuth documentation](https://developers.openai.com/plugins/build/auth),
and [Auth0's ChatGPT walkthrough](https://auth0.com/blog/add-remote-mcp-server-chatgpt/).

## Embed from one prompt

For the built-in Notion tool, create a dedicated internal Notion connection
with **Read content** and **Insert content**, and grant it access to the pages
you want agents to use. Set `ENRIKDRAW_NOTION_TOKEN` to the connection secret
and `ENRIKDRAW_NOTION_PAGES` to a JSON map from names you use in conversation to
their page UUIDs.

```json
{"Project notes":"11111111-1111-4111-8111-111111111111"}
```

Deploy, grant the client `drawings:write` and `notion:embed`, and refresh its
tools. Use the configured page name in your prompt.

> @EnrikDraw Visualize our release process as a flowchart in my Project notes Notion page.

The agent creates a drawing, resolves the allowed destination and appends a
live embed block. Confirm the action if the client asks. The tool can only
append the app's own drawing URLs to the configured pages. With no built-in
Notion connection, an agent can hand `embedUrl` to a separate authorized
integration that can create an embed block, or return it for pasting into
Notion's `/embed` block.

An editable URL grants browser access to that drawing. Share the destination
page with the people you intend to have that access. The optional Notion
connection token stays on the EnrikDraw server.

See [Notion's embed block format](https://developers.notion.com/reference/block#embed)
and [Notion's append endpoint](https://developers.notion.com/reference/patch-block-children).

## Tools

| Tool | Required scope | Use |
|---|---|---|
| `enrikdraw_list_drawings` | `drawings:read` | Find existing drawings by title and ID. |
| `enrikdraw_inspect_drawing` | `drawings:read` | Read the revision and element IDs, text, geometry and styling. Clients that also have `drawings:write` receive editable URLs. |
| `enrikdraw_create_drawing` | `drawings:write` | Create a native scene and return its permanent URLs. |
| `enrikdraw_edit_drawing` | `drawings:write` | Rename or batch element additions, updates and removals against one revision. |
| `enrikdraw_delete_drawing` | `drawings:delete` | Delete an exact drawing using its revision and title. |
| `enrikdraw_list_notion_destinations` | `drawings:write`, `notion:embed` | List configured page names. |
| `enrikdraw_embed_in_notion` | `drawings:write`, `notion:embed` | Append one live embed per drawing and destination. |

This `enrikdraw_create_drawing` input creates a flowchart with two labeled nodes.

```json
{
  "requestId": "76ae37f2-9f8b-4fa2-8f39-46480c47942d",
  "title": "Release flow",
  "elements": [
    {"id":"review","type":"rectangle","x":0,"y":0,"width":180,"height":70,"backgroundColor":"#d0ebff"},
    {"id":"review-label","type":"text","x":49,"y":22,"text":"Review","fontSize":20},
    {"id":"to-ship","type":"arrow","points":[[190,35],[260,35]]},
    {"id":"ship","type":"rectangle","x":270,"y":0,"width":180,"height":70,"backgroundColor":"#d3f9d8"},
    {"id":"ship-label","type":"text","x":331,"y":22,"text":"Ship","fontSize":20}
  ]
}
```

Use a fresh random `requestId` for each new drawing and the same ID and input
when retrying a create. Each edit operation is `{"op":"add","element":{...}}`,
`{"op":"update","id":"review-label","changes":{"text":"Approve"}}`, or
`{"op":"remove","id":"to-ship"}`. Put the operations in an array alongside the
drawing `id` and current `revision`. A conflict means inspect again and compare
the intended edit to the latest state. Each accepted write is atomic. An open
editor checks for a newer revision when focused and periodically while visible.

Agent tools author rectangles, diamonds, ellipses, text, lines and arrows.
Existing drawings can also contain images, frames, groups, freehand strokes
and other native elements. Edits preserve unrelated elements, app state and
embedded files. Agent-created labels and arrows are independent elements.
Use the editor for geometry changes to bound elements, elbow arrows, and
frames containing other elements. Locked elements require unlocking in the
editor first. Inspect results are paginated and omit binary image data.

The Notion tool checks for an existing top-level embed before appending. If
Notion's response is lost, retry the same drawing and destination to look for
the existing embed. If it stays pending, check the page manually before clearing
the matching `drawing_id` and `page_id` reservation from `public.notion_embeds`
in Supabase. Clear that reservation after removing a previously created block
if you want the tool to append a fresh one.
