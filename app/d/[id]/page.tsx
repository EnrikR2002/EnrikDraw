/**
 * The drawing editor page.
 *
 * The capability token is checked here, before anything touches the database,
 * so a drawing id on its own cannot even be used to find out whether a drawing
 * exists.
 */
import { supabase, type DrawingRow } from "@/lib/supabase";
import { isValidToken } from "@/lib/token";
import DrawingEditor from "./DrawingEditor";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Props = {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

function Problem({ heading, detail }: { heading: string; detail: string }) {
  return (
    <main className="centred">
      <div>
        <h1>{heading}</h1>
        <p>{detail}</p>
      </div>
    </main>
  );
}

function firstValue(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

export default async function DrawingPage({ params, searchParams }: Props) {
  const { id } = await params;
  const query = await searchParams;
  const token = firstValue(query.token);
  const isEmbed = firstValue(query.embed) === "1";

  if (!UUID.test(id) || !isValidToken(id, token)) {
    return (
      <Problem
        heading="This link is not valid"
        detail="The access token is missing or wrong. Open the drawing again from EnrikDraw to get a fresh link."
      />
    );
  }

  const { data, error } = await supabase()
    .from("drawings")
    .select("id, title, scene")
    .eq("id", id)
    .maybeSingle();

  if (error) {
    console.error("[enrikdraw] could not load drawing", id, error.message);
    return (
      <Problem
        heading="Could not reach the database"
        detail="The drawing could not be loaded. Check your connection and reload the page."
      />
    );
  }

  if (!data) {
    return (
      <Problem
        heading="Drawing not found"
        detail="It has been deleted, or the link points at something that never existed."
      />
    );
  }

  const drawing = data as Pick<DrawingRow, "id" | "title" | "scene">;

  return (
    <DrawingEditor
      id={drawing.id}
      title={drawing.title}
      // token is already in this page's URL, so passing it on adds no exposure.
      token={token as string}
      initialScene={drawing.scene}
      embed={isEmbed}
    />
  );
}
