// Step 5 (一页页生成): render the confirmed draft's slides, one image per slide.
// Streams the same page_* / done ProgressEvents as /api/generate, over an existing project.

import { renderProject } from "@/lib/pipeline";
import { loadProject } from "@/lib/store";
import { type ProgressEvent } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 600;

export async function POST(req: Request, { params: paramsPromise }: { params: Promise<{ id: string }> }) {
  const params = await paramsPromise;
  if (!loadProject(params.id)) {
    return new Response(JSON.stringify({ error: "project not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }

  const encoder = new TextEncoder();
  const abort = new AbortController();
  req.signal?.addEventListener("abort", () => abort.abort());

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (e: ProgressEvent) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(e)}\n\n`));
        } catch {
          /* controller closed */
        }
      };
      try {
        await renderProject(params.id, send, { signal: abort.signal });
      } catch (e: any) {
        send({ type: "error", error: String(e?.message ?? e) });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
