import fs from "node:fs";
import { NextResponse } from "next/server";
import { loadProject, syncProjectFiles } from "@/lib/store";
import { archiveStagedMaterialsToDesignFiles } from "@/lib/materials";
import { listProjectFiles, loadProjectFileReferences, uniqueUploadPath } from "@/lib/projectFiles";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params: paramsPromise }: { params: Promise<{ id: string }> }) {
  const params = await paramsPromise;
  const project = loadProject(params.id);
  if (!project) return NextResponse.json({ error: "not found" }, { status: 404 });
  syncProjectFiles(project);
  return NextResponse.json({ files: listProjectFiles(params.id) });
}

export async function POST(req: Request, { params: paramsPromise }: { params: Promise<{ id: string }> }) {
  const params = await paramsPromise;
  if (!loadProject(params.id)) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (req.headers.get("content-type")?.includes("application/json")) {
    const body = await req.json().catch(() => ({}));
    const rawMaterialIds: unknown[] = Array.isArray(body?.materialIds) ? body.materialIds : [];
    const materialIds: string[] = [...new Set(rawMaterialIds.map((id) => String(id)))].slice(0, 16);
    if (!materialIds.length) {
      return NextResponse.json({ error: "materialIds required" }, { status: 400 });
    }
    const archivedPaths = archiveStagedMaterialsToDesignFiles(params.id, materialIds);
    if (!archivedPaths.length) {
      return NextResponse.json({ error: "no staged files found" }, { status: 404 });
    }
    const { references } = loadProjectFileReferences(params.id, archivedPaths);
    return NextResponse.json({
      files: listProjectFiles(params.id),
      references,
    });
  }
  const form = await req.formData().catch(() => null);
  const uploads = form?.getAll("files") ?? [];
  if (!uploads.length || uploads.some((file) => !(file instanceof File))) {
    return NextResponse.json({ error: "files required" }, { status: 400 });
  }
  for (const upload of uploads as File[]) {
    if (upload.size > 20 * 1024 * 1024) return NextResponse.json({ error: `${upload.name} exceeds 20 MB` }, { status: 413 });
    fs.writeFileSync(uniqueUploadPath(params.id, upload.name), Buffer.from(await upload.arrayBuffer()));
  }
  return NextResponse.json({ files: listProjectFiles(params.id) });
}
