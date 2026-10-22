import { NextResponse } from "next/server";
import {
  captureDeckVersion,
  ensureCurrentDeckVersion,
  listDeckVersions,
  versionPromptForProject,
} from "@/lib/deckVersions";
import { loadProject } from "@/lib/store";
import type { DeckVersionPromptSource, DeckVersionSource } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function source(value: unknown): DeckVersionSource {
  return value === "manual" || value === "restore" ? value : "ai";
}

function promptSource(value: unknown): DeckVersionPromptSource | undefined {
  return value === "message" || value === "project" || value === "manual" || value === "restore"
    ? value
    : undefined;
}

export async function GET(_req: Request, { params: paramsPromise }: { params: Promise<{ id: string }> }) {
  const params = await paramsPromise;
  const project = loadProject(params.id);
  if (!project) return NextResponse.json({ error: "project not found" }, { status: 404 });
  try {
    await ensureCurrentDeckVersion(project, {
      prompt: versionPromptForProject(project),
      promptSource: "project",
      source: "ai",
    });
    return NextResponse.json(
      { versions: listDeckVersions(project.id).sort((a, b) => b.version - a.version) },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error: any) {
    return NextResponse.json({ error: String(error?.message ?? error) }, { status: 500 });
  }
}

/** Explicit snapshot endpoint for CLI/MCP and grouped multi-step mutations. */
export async function POST(req: Request, { params: paramsPromise }: { params: Promise<{ id: string }> }) {
  const params = await paramsPromise;
  const body = await req.json().catch(() => ({}));
  const project = loadProject(params.id);
  if (!project) return NextResponse.json({ error: "project not found" }, { status: 404 });
  try {
    const version = await captureDeckVersion(project, {
      prompt: typeof body.prompt === "string" ? body.prompt : undefined,
      promptSource: promptSource(body.promptSource),
      source: source(body.source),
      label: typeof body.label === "string" ? body.label : undefined,
      groupId: typeof body.groupId === "string" ? body.groupId : undefined,
      // POST is an explicit checkpoint command. Unlike GET's self-healing
      // ensure path, it must append even when the bytes did not change.
      force: true,
    });
    return NextResponse.json({ version });
  } catch (error: any) {
    return NextResponse.json({ error: String(error?.message ?? error) }, { status: 500 });
  }
}
