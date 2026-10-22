// Step 3 (编辑大纲): edit a draft project's outline before rendering.
//  - PUT  { pages: [{title, points}] }  → replace the whole outline (edit/add/remove/reorder)
//  - POST { message }                   → natural-language revision via the agent
// Both keep the project a draft (no images) — rendering is a separate, confirmed step.

import { NextResponse } from "next/server";
import { reviseOutline } from "@/lib/pipeline";
import { loadProjectFileReferences } from "@/lib/projectFiles";
import { loadProject, replaceProjectPages } from "@/lib/store";
import type { SlidePage } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 600;

function coercePoints(raw: any): string[] {
  if (Array.isArray(raw)) return raw.map((x) => String(x).trim()).filter(Boolean);
  if (typeof raw === "string") return raw.split("\n").map((s) => s.trim()).filter(Boolean);
  return [];
}

/** Replace the outline with an edited list of pages (draft only, drops images). */
export async function PUT(req: Request, { params: paramsPromise }: { params: Promise<{ id: string }> }) {
  const params = await paramsPromise;
  const body = await req.json().catch(() => ({}));
  const incoming = Array.isArray(body?.pages) ? body.pages : [];
  const pages: SlidePage[] = incoming
    .map((p: any, i: number) => ({
      index: i + 1,
      title: String(p?.title ?? "").trim() || `Slide ${i + 1}`,
      points: coercePoints(p?.points),
      status: "pending" as const,
    }));
  if (!pages.length) return NextResponse.json({ error: "at least one slide is required" }, { status: 400 });
  const project = loadProject(params.id);
  if (!project) return NextResponse.json({ error: "project not found" }, { status: 404 });
  project.status = "draft";
  project.workflow = { ...(project.workflow ?? {}), stage: "outline" };
  replaceProjectPages(project, pages);
  return NextResponse.json({ pages: project.pages });
}

/** Natural-language outline revision (add/remove/reorder/rewrite). */
export async function POST(req: Request, { params: paramsPromise }: { params: Promise<{ id: string }> }) {
  const params = await paramsPromise;
  const body = await req.json().catch(() => ({}));
  const message = String(body?.message ?? "").trim();
  if (!message) return NextResponse.json({ error: "message required" }, { status: 400 });
  try {
    const requestedPaths = Array.isArray(body?.designFilePaths)
      ? body.designFilePaths.map(String).slice(0, 12)
      : [];
    const { references, attachments } = loadProjectFileReferences(params.id, requestedPaths);
    const { pages, reply } = await reviseOutline(params.id, message, {
      attachments,
      designFiles: references,
    });
    return NextResponse.json({ pages, reply });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message ?? e) }, { status: 500 });
  }
}
