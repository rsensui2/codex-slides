import { NextResponse } from "next/server";
import { readDeckVersion } from "@/lib/deckVersions";
import { loadProject } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  { params: paramsPromise }: { params: Promise<{ id: string; versionId: string }> },
) {
  const params = await paramsPromise;
  if (!loadProject(params.id)) return NextResponse.json({ error: "project not found" }, { status: 404 });
  try {
    return NextResponse.json(readDeckVersion(params.id, params.versionId), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error: any) {
    return NextResponse.json({ error: String(error?.message ?? error) }, { status: 404 });
  }
}

