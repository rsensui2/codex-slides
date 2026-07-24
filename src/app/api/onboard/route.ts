import { generateOnboardQuestions } from "@/lib/onboard";
import { loadProjectInputAttachments } from "@/lib/materials";
import { loadProject } from "@/lib/store";
import { isUiLocale } from "@/i18n/messages";
import type { ProgressEvent } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const requirement = String(body?.requirement ?? "").trim();
  const uiLocale = isUiLocale(body?.uiLocale) ? body.uiLocale : "ja";
  const scenarioId = String(body?.scenarioId ?? "");
  const projectId = String(body?.projectId ?? "").trim();
  if (!requirement) {
    return new Response(JSON.stringify({ error: "requirement is required" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const encoder = new TextEncoder();
  const abort = new AbortController();
  req.signal?.addEventListener("abort", () => abort.abort());
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: ProgressEvent) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        } catch {
          // The browser left the workflow while generation was still running.
        }
      };
      try {
        const project = projectId ? loadProject(projectId) : null;
        const attachments = project
          ? loadProjectInputAttachments(project.id, project.materials)
          : [];
        const questions = await generateOnboardQuestions(
          requirement,
          abort.signal,
          uiLocale,
          scenarioId,
          (question, index) => send({ type: "question", question, index }),
          attachments,
        );
        send({ type: "questions_done", questions });
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
