import { NextResponse } from "next/server";
import { captureDeckVersion } from "@/lib/deckVersions";
import { generateSpeakerNotes } from "@/lib/speakerNotes";
import { loadProject, saveProject } from "@/lib/store";
import type { Project } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 600;

const MAX_NOTE_LENGTH = 20_000;

function notesPayload(project: Project, generated?: number[]) {
  return {
    projectId: project.id,
    pages: project.pages,
    notes: project.pages.map((page) => ({
      index: page.index,
      title: page.title,
      note: page.speakerNotes ?? "",
    })),
    ...(generated ? { generated } : {}),
  };
}

function requestedIndex(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const index = Number(value);
  return Number.isInteger(index) && index > 0 ? index : Number.NaN;
}

export async function GET(req: Request, { params: paramsPromise }: { params: Promise<{ id: string }> }) {
  const params = await paramsPromise;
  const project = loadProject(params.id);
  if (!project) return NextResponse.json({ error: "project not found" }, { status: 404 });
  const index = requestedIndex(new URL(req.url).searchParams.get("index"));
  if (Number.isNaN(index)) return NextResponse.json({ error: "index must be a positive integer" }, { status: 400 });
  if (index !== undefined && !project.pages.some((page) => page.index === index)) {
    return NextResponse.json({ error: "page not found" }, { status: 404 });
  }
  const payload = notesPayload(project);
  return NextResponse.json(index === undefined
    ? payload
    : { ...payload, notes: payload.notes.filter((note) => note.index === index) });
}

/** Set one note or several notes directly. Empty strings intentionally clear. */
export async function PUT(req: Request, { params: paramsPromise }: { params: Promise<{ id: string }> }) {
  const params = await paramsPromise;
  const project = loadProject(params.id);
  if (!project) return NextResponse.json({ error: "project not found" }, { status: 404 });
  const body = await req.json().catch(() => ({}));
  const updates: Array<{ index: number; note: string }> = [];
  const index = requestedIndex(body.index);
  if (Number.isNaN(index)) return NextResponse.json({ error: "index must be a positive integer" }, { status: 400 });
  if (index !== undefined && typeof body.note === "string") {
    updates.push({ index, note: body.note });
  }
  if (Array.isArray(body.notes)) {
    body.notes.forEach((item: unknown, position: number) => {
      if (typeof item === "string") {
        updates.push({ index: position + 1, note: item });
        return;
      }
      if (!item || typeof item !== "object") return;
      const record = item as Record<string, unknown>;
      const itemIndex = requestedIndex(record.index ?? record.slideIndex);
      const note = record.note ?? record.speakerNotes;
      if (itemIndex !== undefined && !Number.isNaN(itemIndex) && typeof note === "string") {
        updates.push({ index: itemIndex, note });
      }
    });
  }
  if (!updates.length) {
    return NextResponse.json({ error: "provide index + note or a notes array" }, { status: 400 });
  }
  for (const update of updates) {
    const page = project.pages.find((candidate) => candidate.index === update.index);
    if (!page) return NextResponse.json({ error: `page ${update.index} not found` }, { status: 404 });
    if (update.note.length > MAX_NOTE_LENGTH) {
      return NextResponse.json({ error: `speaker notes for page ${update.index} exceed ${MAX_NOTE_LENGTH} characters` }, { status: 400 });
    }
    page.speakerNotes = update.note.trim() || undefined;
  }
  saveProject(project);
  const version = await captureDeckVersion(project.id, {
    prompt: typeof body.versionPrompt === "string"
      ? body.versionPrompt
      : `Update speaker notes for slide${updates.length === 1 ? ` ${updates[0].index}` : "s"}`,
    promptSource: "manual",
    source: "manual",
    label: "Updated speaker notes",
    groupId: typeof body.versionGroupId === "string" ? body.versionGroupId : undefined,
  });
  return NextResponse.json({ ...notesPayload(project), version });
}

/** Generate the current slide or a coherent full-deck talk track with AI. */
export async function POST(req: Request, { params: paramsPromise }: { params: Promise<{ id: string }> }) {
  const params = await paramsPromise;
  const project = loadProject(params.id);
  if (!project) return NextResponse.json({ error: "project not found" }, { status: 404 });
  const body = await req.json().catch(() => ({}));
  const index = requestedIndex(body.index);
  if (Number.isNaN(index)) return NextResponse.json({ error: "index must be a positive integer" }, { status: 400 });
  if (index !== undefined && !project.pages.some((page) => page.index === index)) {
    return NextResponse.json({ error: "page not found" }, { status: 404 });
  }
  const overwrite = body.overwrite === true;
  const targets = project.pages
    .filter((page) => index === undefined || page.index === index)
    .filter((page) => overwrite || !page.speakerNotes?.trim())
    .map((page) => page.index);
  if (!targets.length) return NextResponse.json(notesPayload(project, []));

  try {
    const generatedNotes = await generateSpeakerNotes(project, targets, {
      instruction: typeof body.instruction === "string" ? body.instruction.slice(0, 2_000) : undefined,
      signal: req.signal,
    });
    // Generation can take a while. Merge into the newest snapshot so chat,
    // slide edits, and manual note saves made in parallel are not overwritten.
    const latest = loadProject(params.id);
    if (!latest) return NextResponse.json({ error: "project not found" }, { status: 404 });
    const generated: number[] = [];
    for (const item of generatedNotes) {
      const page = latest.pages.find((candidate) => candidate.index === item.index);
      if (!page || (!overwrite && page.speakerNotes?.trim())) continue;
      page.speakerNotes = item.note.slice(0, MAX_NOTE_LENGTH);
      generated.push(item.index);
    }
    saveProject(latest);
    const version = await captureDeckVersion(latest.id, {
      prompt: typeof body.instruction === "string" && body.instruction.trim()
        ? body.instruction
        : "Generate speaker notes",
      promptSource: "message",
      source: "ai",
      label: "Generated speaker notes",
      groupId: typeof body.versionGroupId === "string" ? body.versionGroupId : undefined,
    });
    return NextResponse.json({ ...notesPayload(latest, generated), version });
  } catch (error: any) {
    return NextResponse.json({ error: String(error?.message ?? error) }, { status: 500 });
  }
}
