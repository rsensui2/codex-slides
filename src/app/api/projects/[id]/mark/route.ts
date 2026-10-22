import { NextResponse } from "next/server";
import { captureDeckVersion } from "@/lib/deckVersions";
import { markEditPage } from "@/lib/pipeline";
import { readSlideImage } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 600;

/**
 * Mark-driven edit. Accepts multipart/form-data:
 *   index: number
 *   note:  string (optional)
 *   source: unique filename of the already-saved annotated slide screenshot.
 *   image:  legacy fallback containing the annotated screenshot directly.
 */
export async function POST(req: Request, { params: paramsPromise }: { params: Promise<{ id: string }> }) {
  const params = await paramsPromise;
  const startedAt = Date.now();
  const form = await req.formData().catch(() => null);
  if (!form) return NextResponse.json({ error: "expected multipart form" }, { status: 400 });

  const index = Number(form.get("index"));
  const note = String(form.get("note") ?? "");
  const source = String(form.get("source") ?? "");
  const file = form.get("image");
  if (!Number.isInteger(index) || (!source && !(file instanceof Blob))) {
    return NextResponse.json({ error: "index and annotated image are required" }, { status: 400 });
  }
  try {
    const expectedPrefix = `mark-${String(index).padStart(2, "0")}-`;
    const bytes = source && source.startsWith(expectedPrefix)
      ? readSlideImage(params.id, source)
      : file instanceof Blob
        ? Buffer.from(await file.arrayBuffer())
        : null;
    if (!bytes) {
      return NextResponse.json({ error: "annotated image not found" }, { status: 404 });
    }
    console.info("[mark] edit started", { projectId: params.id, index, source, bytes: bytes.length });
    const page = await markEditPage(params.id, index, bytes, note);
    const version = await captureDeckVersion(params.id, {
      prompt: note || `Apply marked edits to slide ${index}`,
      promptSource: "message",
      source: "ai",
      label: `Marked slide ${index}`,
      groupId: typeof form.get("versionGroupId") === "string" ? String(form.get("versionGroupId")) : undefined,
    });
    console.info("[mark] edit completed", {
      projectId: params.id,
      index,
      durationMs: Date.now() - startedAt,
    });
    return NextResponse.json({ page, version });
  } catch (e: any) {
    console.error("[mark] edit failed", {
      projectId: params.id,
      index,
      durationMs: Date.now() - startedAt,
      error: String(e?.message ?? e),
      stack: e?.stack,
    });
    return NextResponse.json({ error: String(e?.message ?? e) }, { status: 500 });
  }
}
