import { readSlideImageAsset } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  req: Request,
  { params: paramsPromise }: { params: Promise<{ id: string; name: string }> },
) {
  const params = await paramsPromise;
  const asset = readSlideImageAsset(params.id, params.name);
  if (!asset) return new Response("not found", { status: 404 });
  const searchParams = new URL(req.url).searchParams;
  const versioned = searchParams.has("v") || searchParams.has("t");
  const headers = {
    "Content-Type": "image/png",
    "Content-Length": String(asset.size),
    "Cache-Control": versioned
      ? "public, max-age=31536000, immutable"
      : "private, no-cache, must-revalidate",
    ETag: asset.etag,
    "Last-Modified": asset.lastModified,
    "X-Content-Type-Options": "nosniff",
  };
  if (req.headers.get("if-none-match")?.split(",").map((value) => value.trim()).includes(asset.etag)) {
    return new Response(null, { status: 304, headers });
  }
  return new Response(new Uint8Array(asset.bytes), { headers });
}
