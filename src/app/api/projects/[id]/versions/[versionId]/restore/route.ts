import { NextResponse } from "next/server";
import { restoreDeckVersion } from "@/lib/deckVersions";
import { loadProject } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  req: Request,
  { params: paramsPromise }: { params: Promise<{ id: string; versionId: string }> },
) {
  const params = await paramsPromise;
  if (!loadProject(params.id)) return NextResponse.json({ error: "project not found" }, { status: 404 });
  const body = await req.json().catch(() => ({}));
  try {
    return NextResponse.json(await restoreDeckVersion(
      params.id,
      params.versionId,
      typeof body.prompt === "string" ? body.prompt : undefined,
    ));
  } catch (error: any) {
    const message = String(error?.message ?? error);
    const status = /active project task/i.test(message) ? 409 : 400;
    return NextResponse.json({ error: message }, { status });
  }
}

