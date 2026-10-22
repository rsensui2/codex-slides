import { readStagedMaterial, readStagedMaterialInfo } from "@/lib/materials";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params: paramsPromise }: { params: Promise<{ id: string }> }) {
  const params = await paramsPromise;
  const bytes = readStagedMaterial(params.id);
  if (!bytes) return new Response("not found", { status: 404 });
  const info = readStagedMaterialInfo(params.id);
  const mimeType = info?.mimeType || (info?.kind === "image" ? "image/png" : "application/octet-stream");
  return new Response(new Uint8Array(bytes), {
    headers: {
      "Content-Type": mimeType,
      "Content-Disposition": `${info?.kind === "image" ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(info?.name ?? params.id)}`,
      "Cache-Control": "no-cache",
    },
  });
}
