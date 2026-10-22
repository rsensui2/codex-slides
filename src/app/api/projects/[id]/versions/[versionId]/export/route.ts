import { buildPdf, buildPptx } from "@/lib/assemble";
import { readDeckVersion, readDeckVersionImage } from "@/lib/deckVersions";
import { slugify } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

function attachmentName(base: string, extension: "pdf" | "pptx") {
  const unicodeName = `${base}.${extension}`;
  const fallback = base
    .normalize("NFKD")
    .replace(/[^\x20-\x7E]+/g, "-")
    .replace(/["\\]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "") || "presentation-version";
  return `attachment; filename="${fallback}.${extension}"; filename*=UTF-8''${encodeURIComponent(unicodeName)}`;
}

export async function GET(
  req: Request,
  { params: paramsPromise }: { params: Promise<{ id: string; versionId: string }> },
) {
  const params = await paramsPromise;
  try {
    const detail = readDeckVersion(params.id, params.versionId);
    const format = new URL(req.url).searchParams.get("format") === "pptx" ? "pptx" : "pdf";
    const readImage = (name: string) => readDeckVersionImage(params.id, params.versionId, name);
    const base = `${slugify(detail.project.title)}-v${detail.version.version}`;
    if (format === "pptx") {
      const bytes = await buildPptx(detail.project, readImage);
      return new Response(new Uint8Array(bytes), {
        headers: {
          "Content-Type": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
          "Content-Disposition": attachmentName(base, "pptx"),
        },
      });
    }
    const bytes = await buildPdf(detail.project, readImage);
    return new Response(new Uint8Array(bytes), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": attachmentName(base, "pdf"),
      },
    });
  } catch (error: any) {
    return new Response(String(error?.message ?? error), { status: 404 });
  }
}

