# EnrikDraw

Excalidraw plus permanent cloud documents, autosave, and a URL you can paste
into a Notion `/embed` block.

It is not a rewrite of Excalidraw. The real Excalidraw editor does all the
drawing, exporting and importing. EnrikDraw only adds:

- one saved document per drawing, each with its own permanent URL
- autosave to Supabase Postgres
- a private page to create, rename and delete drawings
- headers that let Notion put the editor in an iframe

There are no folders, tags, search, thumbnails, sharing or version history.
Notion organises the drawings; this app just stores them.

---

## The two pages

**`/manage`** — the private list. Create a drawing, open it, copy its Notion
embed URL, rename it, delete it. Protected by HTTP Basic Authentication.

**`/d/<id>?token=<token>`** — the editor for one drawing. A thin header shows
the title, the save state, a Copy Embed URL button and a link back to
`/manage`. Everything below it is Excalidraw.

Add `&embed=1` for Notion. The header disappears and Excalidraw fills the
whole iframe. It stays fully editable and autosave keeps running.

---

## Environment variables

| Name | Secret | What it is |
|---|---|---|
| `NEXT_PUBLIC_APP_URL` | no | This app's public address, no trailing slash, for example `https://enrikdraw.vercel.app`. Used to build the URLs shown on `/manage`. Leave it empty and the app reads the address from the request instead. |
| `SUPABASE_URL` | no | Your Supabase project URL. |
| `SUPABASE_SERVICE_ROLE_KEY` | **yes** | Supabase service role key. Server side only. |
| `OWNER_USERNAME` | no | The username for `/manage`. |
| `OWNER_PASSWORD` | **yes** | The password for `/manage`. |
| `DRAWING_ACCESS_SECRET` | **yes** | The key used to derive each drawing's access token. |
| `FRAME_ANCESTORS` | no | Optional. Overrides which sites may embed the app. Only set it if a Notion embed shows a blank box. |

`.env.example` lists the same names with notes.

No secret reaches the browser bundle. Even `NEXT_PUBLIC_APP_URL` is only read
on the server.

Generate `DRAWING_ACCESS_SECRET` with:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

Keep it. Changing it invalidates every drawing URL you have already pasted
into Notion.

---

## Supabase setup

1. Create a free project at supabase.com.
2. Open **SQL Editor**, then click **New query**.
3. Paste the whole of `supabase/schema.sql` and click **Run**.
4. Open **Project Settings → Data API**. Copy the **Project URL** into `SUPABASE_URL`.
5. Open **Project Settings → API Keys**. Copy the **service_role** key into `SUPABASE_SERVICE_ROLE_KEY`.

The table has row level security switched on and no policies at all. That is
deliberate. Every request goes through this app's server routes using the
service role key, which ignores row level security. The public anon key can
read and write nothing, so a leaked public key exposes no drawings.

---

## Local development

Install, which also copies the Excalidraw fonts into `public/`:

```bash
npm install
```

Create your own env file:

```bash
cp .env.example .env.local
```

Fill in `.env.local`, then start the dev server:

```bash
npm run dev
```

Open http://localhost:3000/manage. The browser asks for the username and
password from `OWNER_USERNAME` and `OWNER_PASSWORD`.

Check types:

```bash
npm run typecheck
```

Check lint:

```bash
npm run lint
```

Build:

```bash
npm run build
```

`npm install` runs `scripts/copy-excalidraw-assets.mjs`, which copies
Excalidraw's hand-drawn fonts from `node_modules` into
`public/excalidraw-assets/`. That folder is not in git. It is rebuilt on every
install, including on Vercel. Without it Excalidraw fetches those fonts from a
public CDN instead.

---

## Deploy to Vercel

1. Put this folder in a Git repository and push it to GitHub.
2. Go to vercel.com/new and import the repository.
3. Vercel detects Next.js. Leave the build settings alone.
4. Open **Environment Variables** and add all six values from the table above.
   Tick **Production**, **Preview** and **Development** for each one. Leave
   `NEXT_PUBLIC_APP_URL` empty for now, because you do not know the address
   yet.
5. Click **Deploy**.
6. Copy the address it gives you, for example `https://enrikdraw.vercel.app`.
7. Set `NEXT_PUBLIC_APP_URL` to that address, then deploy again so `/manage`
   prints absolute URLs.

The Vercel Hobby plan and the Supabase free plan are enough. You do not need a
custom domain.

`FRAME_ANCESTORS` is read when the app is built. If you change it, deploy
again.

---

## Embed a drawing in Notion

1. Open `/manage` and click **Copy Notion Embed URL** next to the drawing. The
   URL looks like
   `https://enrikdraw.vercel.app/d/<id>?token=<token>&embed=1`.
2. In your Notion page, type `/embed` and pick **Embed**.
3. Paste the URL and click **Embed link**.
4. Drag the bottom edge of the block to make it taller.
5. Click inside the block and draw. Changes save by themselves.

The same drawing at its normal URL, without `&embed=1`, shows the same
content. Edit in one place, reload the other, and the change is there.

---

## How the pieces work

### One document per drawing

Each drawing is one row in one table. Opening a drawing loads only that row.
Saving writes only that row. One drawing can never overwrite another.

### The access token

Drawing URLs carry a token instead of asking you to log in, because a login
prompt inside a Notion iframe is unreliable.

The token is `HMAC-SHA256(DRAWING_ACCESS_SECRET, drawingId)`, encoded for
URLs. Nothing is stored in the database. That means:

- a drawing id on its own cannot open anything
- the server can always rebuild a drawing's URL from its id
- deleting the drawing makes its URL dead

Every read and write of `/api/drawings/[id]` checks the token first, before
touching the database, using a constant-time comparison.

`Referrer-Policy: no-referrer` is sent on every response, so the token never
leaks to another site in a `Referer` header.

### What gets saved

The `scene` column holds exactly the `.excalidraw` file format, produced by
Excalidraw's own `serializeAsJSON(elements, appState, files, "local")`. That
is the same function Excalidraw uses for **Save to...**, so the stored text is
portable: copy it into a `.excalidraw` file and it opens anywhere.

Loading runs it back through Excalidraw's `restore()`, which drops temporary
state and repairs anything written by an older version.

Pasted images ride along inside that JSON, under `files`. There is no separate
image pipeline. A drawing with many large images makes a large row. One save
is capped at about 25 MB and returns a clear error above that.

### Autosave

Excalidraw's `onChange` fires constantly, including for panning and selecting.
So the editor does this:

1. On every change, hash the elements with Excalidraw's `hashElementsVersion`.
   If the hash is unchanged, do nothing. Panning and zooming never cause a
   save.
2. If it changed, show **Saving...** and start a 900 ms timer. Each new change
   restarts the timer.
3. When the timer fires, serialise the scene and `PUT` it.
4. Show **Saved**, or **Save failed**.

Only one save is ever in flight. If you keep drawing while a save is running,
the next save starts when that one finishes. An older save can therefore never
land after, and overwrite, a newer one.

A failed save leaves the canvas untouched and logs the reason to the browser
console, without the token and without the drawing contents. The next edit
tries again.

The editor also saves at once when the tab is hidden or closed. If the browser
is killed inside the 900 ms window, that last change is lost. Last write wins.
There is no multi-user syncing.

---

## API

Basic Authentication, for the manager:

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/manage/drawings` | List drawings, with editor and embed URLs. |
| `POST` | `/api/manage/drawings` | Create one. Body: `{"title":"..."}` |
| `PATCH` | `/api/manage/drawings/[id]` | Rename. Body: `{"title":"..."}` |
| `DELETE` | `/api/manage/drawings/[id]` | Delete. |

Token, for the editor:

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/drawings/[id]?token=...` | Read one drawing. |
| `PUT` | `/api/drawings/[id]?token=...` | Save the scene. Body: `{"scene":"..."}` |

`/manage` reads the list straight from Supabase in a server component, so the
page is right the moment it loads. `GET /api/manage/drawings` returns the same
data and is handy from a terminal:

```bash
curl -u "$OWNER_USERNAME:$OWNER_PASSWORD" https://your-app.vercel.app/api/manage/drawings
```

---

## Notes and limits

**Which sites may embed this app.** `next.config.ts` sends
`Content-Security-Policy: frame-ancestors`, listing `'self'` plus the Notion
domains: `notion.so`, `notion.site`, `notion.com` and their subdomains.
`X-Frame-Options` is never sent, on purpose: it has no way to name an
allow-list, so it would block Notion. If an embed ever shows a blank box, open
the browser console on the Notion page. A `frame-ancestors` message names the
domain that was refused, and you can add it with `FRAME_ANCESTORS`.

**Iframe sandboxing.** Notion sandboxes embed iframes. Editing and autosave
were tested and work in a sandbox that grants `allow-same-origin`, which is
what Notion uses, and what every interactive embed such as Figma or Google
Drive needs. The drawing API also answers requests from any origin
(`Access-Control-Allow-Origin: *`), so autosave keeps working even in a
stricter sandbox where the page gets an opaque origin. That open policy costs
nothing: the token in the URL is the only key, and these routes use no cookies
and no sessions, so a caller from another site gains nothing it did not
already have. The manager API is not open in this way.

**Last updated times are UTC.** They are formatted on the server, so a server
and a browser in different time zones cannot disagree.

**One user.** One username, one password, one secret. Anyone holding a drawing
URL can edit that drawing. That is the point: it is how Notion renders it.
