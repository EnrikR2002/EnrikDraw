import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { test } from "node:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { POST as mcp } from "../app/mcp/route";
import { GET as oauthMetadata } from "../app/.well-known/oauth-protected-resource/mcp/route";
import { GET as load, PUT as save } from "../app/api/drawings/[id]/route";
import { DELETE as managerDelete } from "../app/api/manage/drawings/[id]/route";
import { editScene, operationInput } from "../lib/agent-elements";
import { readScene } from "../lib/scene";
import { fixture } from "./postgrest-fixture";

const origin = "https://enrikdraw.example";
const issuer = "https://issuer.example/";
const write = `ed_${"A".repeat(43)}`;
const read = `ed_${"B".repeat(43)}`;
const manager = `Basic ${Buffer.from("owner:owner-pass").toString("base64")}`;
const headers = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
const digest = (value: string) => createHash("sha256").update(value).digest("hex");

function rpc(method: string, params: object = {}, credential: string | null = `Bearer ${write}`) {
  return mcp(new Request(`${origin}/mcp`, {
    method: "POST", headers: { ...headers, ...(credential && { Authorization: credential }) },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  }));
}

test("MCP, editor and manager use the same data and revision gate", async (t) => {
  const { db, rest } = await fixture();
  t.after(() => db.close());
  const pageId = randomUUID();
  const blockId = randomUUID();
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const jwk = { ...await exportJWK(publicKey), kid: "test", alg: "RS256" };
  let notionAppends = 0;
  let appendedUrl: string | undefined;
  const restoreFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    if (request.url.startsWith("https://db.example/rest/v1/")) return rest(request);
    if (request.url === `${issuer}jwks`) return Response.json({ keys: [jwk] });
    if (request.url.startsWith(`https://api.notion.com/v1/blocks/${pageId}/children`)) {
      assert.equal(request.headers.get("Authorization"), "Bearer test-notion");
      if (request.method === "PATCH") {
        notionAppends++;
        const { children } = await request.json();
        assert.equal(children[0].type, "embed");
        appendedUrl = children[0].embed.url;
        // Notion persisted the embed, but the caller lost the response.
        throw new Error("connection reset");
      }
      const results = appendedUrl ? [{ id: blockId, type: "embed", embed: { url: appendedUrl } }] : [];
      return Response.json({ results, next_cursor: null });
    }
    throw new Error("Unexpected test request");
  };
  t.after(() => { globalThis.fetch = restoreFetch; });
  Object.assign(process.env, {
    SUPABASE_URL: "https://db.example", SUPABASE_SERVICE_ROLE_KEY: "test-db", DRAWING_ACCESS_SECRET: "test-drawing-secret",
    OWNER_USERNAME: "owner", OWNER_PASSWORD: "owner-pass", NEXT_PUBLIC_APP_URL: origin,
    ENRIKDRAW_AGENT_KEYS: JSON.stringify([
      { sha256: digest(write), scopes: ["drawings:read", "drawings:write", "drawings:delete", "notion:embed"] },
      { sha256: digest(read), scopes: ["drawings:read"] },
    ]),
    ENRIKDRAW_OAUTH_ISSUER: issuer, ENRIKDRAW_OAUTH_JWKS_URL: `${issuer}jwks`,
    ENRIKDRAW_OAUTH_SUBJECT: "owner-sub", ENRIKDRAW_OAUTH_CLIENT_ID: "chatgpt-client",
    ENRIKDRAW_NOTION_TOKEN: "test-notion", ENRIKDRAW_NOTION_PAGES: JSON.stringify({ "Project notes": pageId }),
  });

  const denied = await rpc("tools/list", {}, null);
  assert.equal(denied.status, 401);
  assert.match(denied.headers.get("WWW-Authenticate")!, /oauth-protected-resource/);
  assert.equal((await rpc("tools/list", {}, manager)).status, 401);
  assert.equal((await oauthMetadata().json()).resource, `${origin}/mcp`);
  assert.equal((await rpc("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "1" } })).status, 200);
  const list = await (await rpc("tools/list")).json();
  assert.equal(list.result.tools.length, 7);

  const jwt = (sub: string, aud = `${origin}/mcp`, azp = "chatgpt-client", exp: string | number = "5m") =>
    new SignJWT({ azp, scope: "drawings:read" }).setProtectedHeader({ alg: "RS256", kid: "test" })
      .setIssuer(issuer).setAudience(aud).setSubject(sub).setIssuedAt().setExpirationTime(exp).sign(privateKey);
  for (const token of [await jwt("other"), await jwt("owner-sub", origin), await jwt("owner-sub", `${origin}/mcp`, "other-client"),
    await jwt("owner-sub", `${origin}/mcp`, "chatgpt-client", 1)]) {
    assert.equal((await rpc("tools/list", {}, `Bearer ${token}`)).status, 401);
  }
  assert.equal((await rpc("tools/list", {}, `Bearer ${await jwt("owner-sub")}`)).status, 200);

  const call = async (tool: string, args: object, token = write) => {
    const response = await rpc("tools/call", { name: `enrikdraw_${tool}`, arguments: args }, `Bearer ${token}`);
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.ok(payload.result, JSON.stringify(payload));
    return payload.result.structuredContent;
  };

  const id = randomUUID();
  const input = { requestId: id, title: "Release flow", elements: [
    { type: "rectangle", id: "box", x: 0, y: 0, width: 200, height: 80 },
    { type: "text", id: "label", x: 20, y: 20, text: "Release" },
    { type: "arrow", id: "arrow", points: [[210, 40], [300, 40], [300, 100]] },
  ] };
  assert.equal((await call("create_drawing", input, read)).code, "insufficient_scope");
  const created = (await call("create_drawing", input)).drawing;
  assert.equal(created.id, id);
  assert.equal((await call("create_drawing", input)).replayed, true);
  assert.equal((await call("create_drawing", { ...input, title: "Other" })).code, "request_id_conflict");
  assert.equal((await call("list_drawings", {})).drawings.length, 1);
  assert.equal((await call("inspect_drawing", { id, limit: 1 }, read)).drawing.embedUrl, undefined);
  assert.equal((await call("inspect_drawing", { id, limit: 1 })).nextOffset, 1);

  const context = { params: Promise.resolve({ id }) };
  const token = new URL(created.embedUrl).searchParams.get("token");
  const editor = `${origin}/api/drawings/${id}?token=${token}`;
  const original = (await (await load(new Request(editor), context)).json()).drawing;
  const invalidBatch = await call("edit_drawing", { id, revision: created.revision, operations: [
    { op: "remove", id: "arrow" }, { op: "remove", id: "absent" },
  ] });
  assert.equal(invalidBatch.code, "invalid_edit");
  assert.equal((await call("inspect_drawing", { id })).totalElements, 3);

  const saveManually = (scene: string, revision: string) => save(new Request(editor, {
    method: "PUT", headers, body: JSON.stringify({ scene, revision }),
  }), context);
  const manualScene = JSON.stringify({ ...JSON.parse(original.scene), appState: { viewBackgroundColor: "#ffffff" }, files: { keep: { dataURL: "data:image/png;base64,AA==" } } });
  const [manual, agent] = await Promise.all([
    saveManually(manualScene, created.revision),
    call("edit_drawing", { id, revision: created.revision, operations: [{ op: "update", id: "label", changes: { text: "Deploy" } }] }),
  ]);
  assert.ok((manual.status === 200 && agent.code === "revision_conflict") || (manual.status === 409 && agent.drawing));
  if (manual.status === 409) {
    assert.equal((await saveManually(manualScene, agent.drawing.revision)).status, 200);
  }
  const before = (await call("inspect_drawing", { id })).drawing;
  const edited = (await call("edit_drawing", { id, revision: before.revision,
    operations: [{ op: "update", id: "label", changes: { text: "Deploy" } }] })).drawing;
  assert.notEqual(edited.revision, before.revision);
  assert.equal(edited.embedUrl, created.embedUrl);
  assert.equal((await saveManually(original.scene, created.revision)).status, 409);
  const updated = JSON.parse((await (await load(new Request(editor), context)).json()).drawing.scene);
  assert.deepEqual(updated.elements[0], JSON.parse(original.scene).elements[0]);
  assert.equal(updated.elements[1].text, "Deploy");
  assert.equal(updated.elements[1].id, "label");
  assert.ok(updated.elements[1].version > 1);
  assert.equal(updated.files.keep.dataURL, "data:image/png;base64,AA==");
  assert.equal(updated.appState.viewBackgroundColor, "#ffffff");

  assert.equal((await call("embed_in_notion", { id, destination: "Another page" })).code, "unknown_destination");
  await Promise.all([call("embed_in_notion", { id, destination: "Project notes" }), call("embed_in_notion", { id, destination: "Project notes" })]);
  assert.equal((await call("embed_in_notion", { id, destination: "Project notes" })).blockId, blockId);
  assert.equal(notionAppends, 1);
  assert.equal(appendedUrl, created.embedUrl);

  assert.equal((await managerDelete(new Request(`${origin}/api/manage/drawings/${id}`, {
    method: "DELETE", headers: { Authorization: manager, "If-Match": `"${created.revision}"` },
  }), context)).status, 409);
  assert.equal((await call("delete_drawing", { id, revision: edited.revision, confirmedTitle: "Wrong" })).code, "title_mismatch");
  assert.equal((await call("delete_drawing", { id, revision: edited.revision, confirmedTitle: input.title })).deleted, true);
  assert.equal((await load(new Request(editor), context)).status, 404);
  assert.equal((await call("create_drawing", input)).code, "not_found");
  assert.equal((await call("list_drawings", {})).drawings.length, 0);
  await db.exec("set role anon;");
  await assert.rejects(db.query("select * from public.drawings"), /permission denied/);
});

test("element edits validate geometry and preserve existing content on failure", () => {
  const empty = readScene(null);
  const add = (id: string) => operationInput.parse({ op: "add", element: { id, type: "line", points: [[40, 20], [10, 20]] } });
  assert.throws(() => editScene(empty, [add("line"), add("line")]), /already exists/);
  assert.equal(empty.elements.length, 0);
  const scene = editScene(empty, [add("line")]);
  assert.deepEqual(scene.elements[0], { ...scene.elements[0], x: 40, y: 20, width: 30, height: 0, points: [[0, 0], [-30, 0]] });
  assert.throws(() => editScene(scene, [operationInput.parse({ op: "update", id: "line", changes: { text: "oops" } })]), /text element/);
});
