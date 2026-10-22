import { NextResponse } from "next/server";
import { loadProject, saveMarkSnapshot } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Save the exact marked-up slide before the slower image edit starts. */
export async function POST(req: Request, { params: paramsPromise }: { params: Promise<{ id: string }> }) {
  const params = await paramsPromise;
  const project = loadProject(params.id);
  if (!project) return NextResponse.json({ error: "project not found" }, { status: 404 });

  const form = await req.formData().catch(() => null);
  if (!form) return NextResponse.json({ error: "expected multipart form" }, { status: 400 });
  const index = Number(form.get("index"));
  const image = form.get("image");
  if (!Number.isInteger(index) || !project.pages.some((page) => page.index === index)) {
    return NextResponse.json({ error: "page not found" }, { status: 404 });
  }
  if (!(image instanceof Blob)) {
    return NextResponse.json({ error: "annotated PNG required" }, { status: 400 });
  }
  if (image.size > 30 * 1024 * 1024) {
    return NextResponse.json({ error: "annotated image exceeds 30 MB" }, { status: 413 });
  }

  const bytes = Buffer.from(await image.arrayBuffer());
  if (bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") {
    return NextResponse.json({ error: "invalid annotated PNG" }, { status: 400 });
  }

  return NextResponse.json({ image: saveMarkSnapshot(project.id, index, bytes) });
}
