import { NextResponse } from "next/server";
import { captureDeckVersion } from "@/lib/deckVersions";
import { regeneratePage } from "@/lib/pipeline";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 600;

export async function POST(req: Request, { params: paramsPromise }: { params: Promise<{ id: string }> }) {
  const params = await paramsPromise;
  const body = await req.json().catch(() => ({}));
  const index = Number(body?.index);
  const instruction = body?.instruction ? String(body.instruction) : undefined;
  const title = body?.title ? String(body.title) : undefined;
  if (!Number.isInteger(index)) {
    return NextResponse.json({ error: "index required" }, { status: 400 });
  }
  try {
    const page = await regeneratePage(params.id, index, instruction, title);
    const version = await captureDeckVersion(params.id, {
      prompt: typeof body.versionPrompt === "string" ? body.versionPrompt : instruction ?? `Regenerate slide ${index}`,
      promptSource: "message",
      source: "ai",
      label: `Updated slide ${index}`,
      groupId: typeof body.versionGroupId === "string" ? body.versionGroupId : undefined,
    });
    return NextResponse.json({ page, version });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message ?? e) }, { status: 500 });
  }
}
