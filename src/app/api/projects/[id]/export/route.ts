import { buildPdf, buildPptx } from "@/lib/assemble";
import { loadProject, slugify } from "@/lib/store";

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
    .replace(/^-|-$/g, "") || "presentation";
  return `attachment; filename="${fallback}.${extension}"; filename*=UTF-8''${encodeURIComponent(unicodeName)}`;
}

export async function GET(req: Request, { params: paramsPromise }: { params: Promise<{ id: string }> }) {
  const params = await paramsPromise;
  const project = loadProject(params.id);
  if (!project) return new Response("not found", { status: 404 });
  const format = new URL(req.url).searchParams.get("format") ?? "pdf";
  const base = slugify(project.title);

  try {
    if (format === "pptx") {
      const buf = await buildPptx(project);
      return new Response(new Uint8Array(buf), {
        headers: {
          "Content-Type":
            "application/vnd.openxmlformats-officedocument.presentationml.presentation",
          "Content-Disposition": attachmentName(base, "pptx"),
        },
      });
    }
    const buf = await buildPdf(project);
    return new Response(new Uint8Array(buf), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": attachmentName(base, "pdf"),
      },
    });
  } catch (e: any) {
    return new Response(String(e?.message ?? e), { status: 500 });
  }
}
