import { NextResponse } from "next/server";
import { readProjectTemplateCover } from "@/lib/projectTemplates";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params: paramsPromise }: { params: Promise<{ id: string }> }) {
  const params = await paramsPromise;
  const cover = readProjectTemplateCover(params.id);
  if (!cover) return NextResponse.json({ error: "not found" }, { status: 404 });
  return new NextResponse(new Uint8Array(cover.bytes), {
    headers: {
      "Content-Type": cover.mimeType,
      "Cache-Control": "no-store",
    },
  });
}
