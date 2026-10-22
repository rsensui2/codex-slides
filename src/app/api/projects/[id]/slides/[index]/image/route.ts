import { NextResponse } from "next/server";
import { captureDeckVersion } from "@/lib/deckVersions";
import { loadProject, saveProject, saveSlideImage } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  req: Request,
  { params: paramsPromise }: { params: Promise<{ id: string; index: string }> },
) {
  const params = await paramsPromise;
  const index = Number(params.index);
  const form = await req.formData();
  const image = form.get("image");
  if (!(image instanceof File)) return NextResponse.json({ error: "image required" }, { status: 400 });
  if (image.type !== "image/png") return NextResponse.json({ error: "normalized PNG required" }, { status: 415 });
  if (image.size > 30 * 1024 * 1024) return NextResponse.json({ error: "image exceeds 30 MB" }, { status: 413 });

  const bytes = Buffer.from(await image.arrayBuffer());
  const pngSignature = bytes.subarray(0, 8).toString("hex");
  if (pngSignature !== "89504e470d0a1a0a") {
    return NextResponse.json({ error: "invalid PNG" }, { status: 400 });
  }

  // Decoding an uploaded image is asynchronous. Load the project afterwards so
  // this endpoint cannot write a stale page array over a concurrent insertion.
  const project = loadProject(params.id);
  if (!project) return NextResponse.json({ error: "project not found" }, { status: 404 });
  const page = project.pages.find((candidate) => candidate.index === index);
  if (!page) return NextResponse.json({ error: "page not found" }, { status: 404 });

  const suppliedTitle = String(form.get("title") ?? "").trim();
  if (suppliedTitle) page.title = suppliedTitle.slice(0, 80);
  page.image = saveSlideImage(project.id, index, bytes);
  page.imageUpdatedAt = Date.now();
  page.status = "rendered";
  page.error = undefined;
  page.description = "User-uploaded slide image";
  project.outline[index - 1] = { title: page.title, points: [...page.points] };
  saveProject(project);
  const version = await captureDeckVersion(project.id, {
    prompt: String(form.get("versionPrompt") ?? "").trim() || `Replace slide ${index} with uploaded image`,
    promptSource: "manual",
    source: "manual",
    label: `Uploaded slide ${index}`,
    groupId: String(form.get("versionGroupId") ?? "").trim() || undefined,
  });
  return NextResponse.json({ page, version });
}
