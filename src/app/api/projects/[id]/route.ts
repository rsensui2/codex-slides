import { NextResponse } from "next/server";
import { coerceConfig } from "@/lib/config";
import { captureDeckVersion, currentDeckVersionSignature } from "@/lib/deckVersions";
import { normalizeDeckDesignSystem } from "@/lib/designSystem";
import { attachMaterialsToProject } from "@/lib/materials";
import { editableProjectSignature, projectResponseEtag } from "@/lib/projectSync";
import { loadProject, saveProject } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params: paramsPromise }: { params: Promise<{ id: string }> }) {
  const params = await paramsPromise;
  const project = loadProject(params.id);
  if (!project) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json(project);
}

/** Re-tune an existing deck: change template / style, add materials. Then the
 *  caller regenerates slides (which read the updated project.config). */
export async function PATCH(req: Request, { params: paramsPromise }: { params: Promise<{ id: string }> }) {
  const params = await paramsPromise;
  const body = await req.json().catch(() => ({}));
  const project = loadProject(params.id);
  if (!project) return NextResponse.json({ error: "not found" }, { status: 404 });
  const beforeSignature = editableProjectSignature(project);
  const beforeDeckSignature = currentDeckVersionSignature(project);
  const requestedWorkflowUpdatedAt = typeof body.workflow?.updatedAt === "number"
    && Number.isFinite(body.workflow.updatedAt)
    ? body.workflow.updatedAt
    : undefined;

  if (body.config && typeof body.config === "object") {
    project.config = coerceConfig({ ...project.config, ...body.config });
  }
  if (typeof body.title === "string" && body.title.trim()) project.title = body.title.trim().slice(0, 120);
  if (typeof body.researchDoc === "string") {
    project.researchDoc = body.researchDoc || undefined;
    project.config.researchDoc = body.researchDoc || undefined;
  }

  const workflowStages = new Set(["clarify", "research", "outlining", "outline", "inspire", "rendering", "deck"]);
  if (body.workflow && typeof body.workflow === "object") {
    const next = body.workflow;
    project.workflow = {
      ...(project.workflow ?? { stage: "outline" as const }),
      ...(workflowStages.has(next.stage) ? { stage: next.stage } : {}),
      ...(typeof next.researchMode === "boolean" ? { researchMode: next.researchMode } : {}),
      ...(Array.isArray(next.questions) ? { questions: next.questions.slice(0, 12) } : {}),
      ...(next.clarifyForm && typeof next.clarifyForm === "object" ? { clarifyForm: next.clarifyForm } : {}),
      ...(typeof next.clarifyAnswerSummary === "string" ? { clarifyAnswerSummary: next.clarifyAnswerSummary } : {}),
      ...(next.workspaceMode === "canvas" || next.workspaceMode === "files" ? { workspaceMode: next.workspaceMode } : {}),
      ...(typeof next.selectedDesignFileId === "string" ? { selectedDesignFileId: next.selectedDesignFileId } : {}),
      ...(typeof next.inspirationSkipped === "boolean" ? { inspirationSkipped: next.inspirationSkipped } : {}),
      ...(typeof next.inspirationSelection === "string"
        ? { inspirationSelection: next.inspirationSelection.slice(0, 160) }
        : {}),
      ...(Array.isArray(next.queuedRequests) ? { queuedRequests: next.queuedRequests.slice(0, 20) } : {}),
    };
  }

  if (typeof body.template !== "undefined") project.config.template = body.template || undefined;
  if (typeof body.style === "string") project.config.style = body.style;

  const materialIdsInput = Array.isArray(body.materialIds)
    ? body.materialIds
    : Array.isArray(body.config?.materialIds)
      ? body.config.materialIds
      : [];
  const requestedMaterialIds: string[] = Array.isArray(materialIdsInput)
    ? Array.from(new Set<string>(materialIdsInput.map((id: unknown) => String(id)))).slice(0, 16)
    : [];
  if (requestedMaterialIds.length) {
    const existingIds = new Set((project.materials ?? []).map((item) => item.id));
    const records = attachMaterialsToProject(
      project.id,
      requestedMaterialIds.filter((id) => !existingIds.has(id)),
    );
    if (records.length) project.materials = [...(project.materials ?? []), ...records];
    const availableIds = new Set((project.materials ?? []).map((item) => item.id));
    project.config.materialIds = Array.from(availableIds);
  }

  if (body.designSystem === null) {
    project.config.designSystem = undefined;
  } else if (body.designSystem && typeof body.designSystem === "object") {
    const designSystem = normalizeDeckDesignSystem(body.designSystem, {
      template: project.config.template,
      style: project.config.style,
    });
    const availableIds = new Set((project.materials ?? []).map((item) => item.id));
    designSystem.brand.assetMaterialIds = designSystem.brand.assetMaterialIds.filter((id) => availableIds.has(id));
    project.config.designSystem = designSystem;
  }
  if (editableProjectSignature(project) === beforeSignature) {
    return NextResponse.json(project, {
      headers: {
        "Cache-Control": "no-store",
        ETag: projectResponseEtag(project),
        "X-Codex-Slides-Write": "skipped",
      },
    });
  }
  if (body.workflow && project.workflow) {
    project.workflow.updatedAt = requestedWorkflowUpdatedAt ?? Date.now();
  }
  saveProject(project);
  const deckChanged = currentDeckVersionSignature(project) !== beforeDeckSignature;
  if (deckChanged && project.pages.some((page) => page.image)) {
    await captureDeckVersion(project.id, {
      prompt: typeof body.versionPrompt === "string"
        ? body.versionPrompt
        : [body.style, body.designSystem?.style?.direction, body.designSystem?.style?.keywords]
            .filter((value) => typeof value === "string" && value.trim())
            .join(". ") || "Update deck style and project settings",
      promptSource: typeof body.versionPrompt === "string" ? "message" : "manual",
      source: typeof body.versionPrompt === "string" ? "ai" : "manual",
      label: "Updated deck settings",
      groupId: typeof body.versionGroupId === "string" ? body.versionGroupId : undefined,
    });
  }
  return NextResponse.json(project, {
    headers: {
      "Cache-Control": "no-store",
      ETag: projectResponseEtag(project),
      "X-Codex-Slides-Write": "saved",
    },
  });
}
