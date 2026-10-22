import { NextResponse } from "next/server";
import { captureDeckVersion } from "@/lib/deckVersions";
import { mergeDeckDesignSystem, normalizeDeckDesignSystem } from "@/lib/designSystem";
import { attachMaterialsToProject } from "@/lib/materials";
import { loadProject, saveProject } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function responseShape(project: NonNullable<ReturnType<typeof loadProject>>) {
  return {
    enabled: Boolean(project.config.designSystem),
    designSystem: normalizeDeckDesignSystem(project.config.designSystem, {
      template: project.config.template,
      style: project.config.style,
    }),
    template: project.config.template,
    style: project.config.style,
    materials: project.materials ?? [],
  };
}

export async function GET(_req: Request, { params: paramsPromise }: { params: Promise<{ id: string }> }) {
  const params = await paramsPromise;
  const project = loadProject(params.id);
  if (!project) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json(responseShape(project));
}

/** Merge a partial system, attach brand assets, or clear the always-on system. */
export async function PATCH(req: Request, { params: paramsPromise }: { params: Promise<{ id: string }> }) {
  const params = await paramsPromise;
  const body = await req.json().catch(() => ({}));
  const project = loadProject(params.id);
  if (!project) return NextResponse.json({ error: "not found" }, { status: 404 });

  if (typeof body.template !== "undefined") project.config.template = body.template || undefined;
  if (typeof body.style === "string") project.config.style = body.style;

  const requestedMaterialIds: string[] = Array.isArray(body.materialIds)
    ? Array.from(new Set<string>(body.materialIds.map((id: unknown) => String(id)))).slice(0, 16)
    : [];
  if (requestedMaterialIds.length) {
    const existingIds = new Set((project.materials ?? []).map((item) => item.id));
    const records = attachMaterialsToProject(
      project.id,
      requestedMaterialIds.filter((id) => !existingIds.has(id)),
    );
    if (records.length) project.materials = [...(project.materials ?? []), ...records];
    const availableIds = new Set((project.materials ?? []).map((item) => item.id));
    project.config.materialIds = Array.from(new Set([
      ...(project.config.materialIds ?? []),
      ...requestedMaterialIds.filter((id) => availableIds.has(id)),
    ]));
  }

  if (body.clear === true) {
    project.config.designSystem = undefined;
  } else {
    const merged = mergeDeckDesignSystem(project.config.designSystem, body.designSystem, {
      template: project.config.template,
      style: project.config.style,
    });
    const availableIds = new Set((project.materials ?? []).map((item) => item.id));
    const explicitBrandIds: string[] | null = Array.isArray(body.brandAssetMaterialIds)
      ? body.brandAssetMaterialIds.map((id: unknown) => String(id))
      : null;
    const desiredBrandIds: string[] = explicitBrandIds ?? [
      ...merged.brand.assetMaterialIds,
      ...requestedMaterialIds,
    ];
    merged.brand.assetMaterialIds = Array.from(new Set<string>(desiredBrandIds))
      .filter((id) => availableIds.has(id))
      .slice(0, 16);
    project.config.designSystem = merged;
    project.config.style = [merged.style.direction, merged.style.keywords].filter(Boolean).join(". ");
  }

  saveProject(project);
  const version = await captureDeckVersion(project.id, {
    prompt: typeof body.versionPrompt === "string"
      ? body.versionPrompt
      : body.clear === true
        ? "Disable the brand design system"
        : "Update the brand design system",
    promptSource: typeof body.versionPrompt === "string" ? "message" : "manual",
    source: typeof body.versionPrompt === "string" ? "ai" : "manual",
    label: "Updated brand design system",
    groupId: typeof body.versionGroupId === "string" ? body.versionGroupId : undefined,
  });
  return NextResponse.json({ ...responseShape(project), project, version });
}
