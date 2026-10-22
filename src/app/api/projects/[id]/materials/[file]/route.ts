import { loadProject } from "@/lib/store";
import { readProjectMaterial } from "@/lib/materials";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Serve persisted brand references back to the design-system editor. */
export async function GET(
  _req: Request,
  { params: paramsPromise }: { params: Promise<{ id: string; file: string }> },
) {
  const params = await paramsPromise;
  const project = loadProject(params.id);
  const record = project?.materials?.find((item) => item.file === params.file);
  if (!record) return new Response("not found", { status: 404 });
  const bytes = readProjectMaterial(params.id, params.file);
  if (!bytes) return new Response("not found", { status: 404 });
  return new Response(new Uint8Array(bytes), {
    headers: {
      "Content-Type": record.mimeType || "application/octet-stream",
      "Cache-Control": "no-store",
    },
  });
}
