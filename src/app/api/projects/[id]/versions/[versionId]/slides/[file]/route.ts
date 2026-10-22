import { readDeckVersionImage } from "@/lib/deckVersions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  { params: paramsPromise }: { params: Promise<{ id: string; versionId: string; file: string }> },
) {
  const params = await paramsPromise;
  try {
    const bytes = readDeckVersionImage(params.id, params.versionId, params.file);
    if (!bytes) return new Response("not found", { status: 404 });
    return new Response(new Uint8Array(bytes), {
      headers: {
        "Content-Type": "image/png",
        "Content-Length": String(bytes.length),
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch {
    return new Response("not found", { status: 404 });
  }
}

