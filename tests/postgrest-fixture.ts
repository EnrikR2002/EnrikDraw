import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";

export async function fixture() {
  const db = await PGlite.create({ extensions: { pgcrypto } });
  await db.exec("create role anon; create role authenticated; create role service_role bypassrls;");
  const schema = await readFile(new URL("../supabase/schema.sql", import.meta.url), "utf8");
  await db.exec(schema);
  await db.exec(schema);

  // A minimal PostgREST test adapter. Filtering and writes run on real Postgres.
  async function rest(request: Request) {
    const url = new URL(request.url);
    const table = url.pathname.slice("/rest/v1/".length);
    if (!["drawings", "notion_embeds"].includes(table)) throw new Error("Unexpected fixture endpoint");
    const identifier = (value: string) => {
      if (!/^[a-z_]+$/.test(value)) throw new Error(`Invalid fixture identifier: ${value}`);
      return `"${value}"`;
    };
    const select = url.searchParams.get("select");
    const columns = select ? select.split(",").map(identifier).join(",") : "*";
    const params: unknown[] = [];
    const bind = (value: unknown) => `$${params.push(value)}`;
    const filter: string[] = [];
    for (const [key, value] of url.searchParams) {
      if (["select", "order", "offset", "limit"].includes(key)) continue;
      if (value === "is.null") filter.push(`${identifier(key)} is null`);
      else if (value.startsWith("eq.")) filter.push(`${identifier(key)} = ${bind(value.slice(3))}`);
      else throw new Error("Unexpected fixture filter");
    }
    const where = filter.length ? ` where ${filter.join(" and ")}` : "";
    const order = url.searchParams.get("order")?.split(",").map((clause) => {
      const [key, direction] = clause.split(".");
      return `${identifier(key)} ${direction === "desc" ? "desc" : "asc"}`;
    }).join(",");
    const offset = url.searchParams.get("offset");
    const limit = url.searchParams.get("limit");
    const returning = request.headers.get("Prefer")?.includes("return=representation") ? ` returning ${columns}` : "";

    let sql: string;
    if (request.method === "GET") {
      sql = `select ${columns} from public.${table}${where}` + (order ? ` order by ${order}` : "") +
        (offset ? ` offset ${bind(offset)}` : "") + (limit ? ` limit ${bind(limit)}` : "");
    } else if (request.method === "DELETE") {
      sql = `delete from public.${table}${where}${returning}`;
    } else {
      const body = Object.entries(await request.json() as Record<string, unknown>);
      if (request.method === "POST") {
        sql = `insert into public.${table} (${body.map(([key]) => identifier(key)).join(",")}) values (${body.map(([, value]) => bind(value)).join(",")})${returning}`;
      } else if (request.method === "PATCH") {
        sql = `update public.${table} set ${body.map(([key, value]) => `${identifier(key)} = ${bind(value)}`).join(",")}${where}${returning}`;
      } else throw new Error("Unexpected fixture method");
    }

    try {
      const { rows } = await db.query(sql, params);
      if (request.method !== "GET" && !returning) return new Response(null, { status: 204 });
      const singular = request.headers.get("Accept") === "application/vnd.pgrst.object+json";
      return Response.json(singular ? rows[0] : rows);
    } catch (error) {
      const { code, message } = error as { code: string; message: string };
      return Response.json({ code, message }, { status: code === "23505" ? 409 : 400 });
    }
  }

  return { db, rest };
}
