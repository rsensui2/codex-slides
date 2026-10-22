import { NextResponse } from "next/server";
import { captureDeckVersion } from "@/lib/deckVersions";
import { loadProject, removeProjectPage, replaceProjectPages, saveProject } from "@/lib/store";
import type { SlidePage, SlideTransition } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function versionInput(body: any, prompt: string, label: string) {
  return {
    prompt: typeof body?.versionPrompt === "string" ? body.versionPrompt : prompt,
    promptSource: "manual" as const,
    source: "manual" as const,
    label,
    groupId: typeof body?.versionGroupId === "string" ? body.versionGroupId : undefined,
  };
}

export async function POST(req: Request, { params: paramsPromise }: { params: Promise<{ id: string }> }) {
  const params = await paramsPromise;
  const body = await req.json().catch(() => ({}));
  const project = loadProject(params.id);
  if (!project) return NextResponse.json({ error: "project not found" }, { status: 404 });
  const action = String(body?.action ?? "add");
  const index = Number(body?.index);

  if (action === "add") {
    const requestedAfter = Number(body?.afterIndex);
    const insertAt = Number.isInteger(requestedAfter)
      ? Math.max(0, Math.min(project.pages.length, requestedAfter))
      : project.pages.length;
    const requestedTitle = String(body?.title ?? "").trim().slice(0, 80);
    const page: SlidePage = {
      index: insertAt + 1,
      title: requestedTitle || `Slide ${insertAt + 1}`,
      points: [],
      status: "pending",
    };
    const pages = [...project.pages];
    pages.splice(insertAt, 0, page);
    replaceProjectPages(project, pages);
    const version = await captureDeckVersion(project.id, versionInput(
      body,
      `Add a slide after slide ${insertAt}`,
      `Added slide ${insertAt + 1}`,
    ));
    return NextResponse.json({ page: project.pages[insertAt], pages: project.pages, version });
  }

  if (action === "duplicate") {
    if (!Number.isInteger(index)) return NextResponse.json({ error: "index required" }, { status: 400 });
    const source = project.pages.find((page) => page.index === index);
    if (!source) return NextResponse.json({ error: "page not found" }, { status: 404 });
    const page: SlidePage = {
      ...source,
      index: index + 1,
      title: `${source.title} copy`,
      points: [...source.points],
    };
    const pages = [...project.pages];
    pages.splice(index, 0, page);
    replaceProjectPages(project, pages);
    const version = await captureDeckVersion(project.id, versionInput(
      body,
      `Duplicate slide ${index}`,
      `Duplicated slide ${index}`,
    ));
    return NextResponse.json({ page: project.pages[index], pages: project.pages, version });
  }

  if (action === "move") {
    const toIndex = Number(body?.toIndex);
    if (!Number.isInteger(index) || !Number.isInteger(toIndex)) {
      return NextResponse.json({ error: "index and toIndex required" }, { status: 400 });
    }
    if (index < 1 || index > project.pages.length || toIndex < 1 || toIndex > project.pages.length) {
      return NextResponse.json({ error: "page not found" }, { status: 404 });
    }
    const pages = [...project.pages];
    const [page] = pages.splice(index - 1, 1);
    pages.splice(toIndex - 1, 0, page);
    replaceProjectPages(project, pages);
    const version = await captureDeckVersion(project.id, versionInput(
      body,
      `Move slide ${index} to position ${toIndex}`,
      `Moved slide ${index}`,
    ));
    return NextResponse.json({ page: project.pages[toIndex - 1], pages: project.pages, version });
  }

  if (action === "transition") {
    if (!Number.isInteger(index)) return NextResponse.json({ error: "index required" }, { status: 400 });
    const page = project.pages.find((item) => item.index === index);
    if (!page) return NextResponse.json({ error: "page not found" }, { status: 404 });
    const transition = String(body?.transition ?? "none") as SlideTransition;
    const allowed: SlideTransition[] = ["none", "fade", "push", "wipe", "zoom", "flip"];
    if (!allowed.includes(transition)) {
      return NextResponse.json({ error: "unsupported transition" }, { status: 400 });
    }
    page.transition = transition;
    saveProject(project);
    const version = await captureDeckVersion(project.id, versionInput(
      body,
      `Set slide ${index} transition to ${transition}`,
      `Changed slide ${index} transition`,
    ));
    return NextResponse.json({ page, pages: project.pages, version });
  }

  return NextResponse.json({ error: "unsupported action" }, { status: 400 });
}

export async function DELETE(req: Request, { params: paramsPromise }: { params: Promise<{ id: string }> }) {
  const params = await paramsPromise;
  const body = await req.json().catch(() => ({}));
  const project = loadProject(params.id);
  if (!project) return NextResponse.json({ error: "project not found" }, { status: 404 });
  const index = Number(body?.index);
  if (!Number.isInteger(index)) return NextResponse.json({ error: "index required" }, { status: 400 });
  try {
    removeProjectPage(project, index);
    const version = await captureDeckVersion(project.id, versionInput(
      body,
      `Delete slide ${index}`,
      `Deleted slide ${index}`,
    ));
    return NextResponse.json({ pages: project.pages, version });
  } catch (error: any) {
    return NextResponse.json({ error: String(error?.message ?? error) }, { status: 404 });
  }
}
