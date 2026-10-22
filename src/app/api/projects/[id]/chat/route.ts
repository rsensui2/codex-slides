import { NextResponse } from "next/server";
import { planChatEdit } from "@/lib/chat";
import { attachMaterialsToProject, loadProjectInputAttachments } from "@/lib/materials";
import { loadProjectFileReferences } from "@/lib/projectFiles";
import { loadProject, saveProject } from "@/lib/store";
import type {
  DesignFileReference,
  StoredAgentTool,
  StoredChatMessage,
  StoredConversation,
  StoredGlobalTodo,
} from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

function finiteNonNegative(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : undefined;
}

function sanitizeDesignFiles(raw: unknown): DesignFileReference[] {
  const seen = new Set<string>();
  return (Array.isArray(raw) ? raw : [])
    .map((file: any) => ({
      path: String(file?.path ?? "").trim().slice(0, 2_000),
      relativePath: String(file?.relativePath ?? "").trim().slice(0, 500),
      name: String(file?.name ?? "").trim().slice(0, 240),
      kind: ["document", "image", "data", "code", "other"].includes(file?.kind) ? file.kind : undefined,
    }))
    .filter((file) => {
      if (!file.path || !file.relativePath || !file.name || seen.has(file.path)) return false;
      seen.add(file.path);
      return true;
    })
    .slice(0, 12);
}

const TOOL_KINDS = ["tool", "read", "write", "edit", "bash", "todo", "files", "search"];
const TODO_STATUS = ["pending", "in_progress", "complete", "error"];

function sanitizeTool(tool: any, index: number): StoredAgentTool {
  return {
    id: String(tool?.id ?? `tool-${index}`),
    name: String(tool?.name ?? "tool"),
    label: String(tool?.label ?? "Tool call"),
    detail: tool?.detail ? String(tool.detail).slice(0, 4_000) : undefined,
    kind: TOOL_KINDS.includes(tool?.kind) ? tool.kind : undefined,
    path: tool?.path ? String(tool.path).slice(0, 2_000) : undefined,
    relativePath: tool?.relativePath ? String(tool.relativePath).slice(0, 500) : undefined,
    command: tool?.command ? String(tool.command).slice(0, 8_000) : undefined,
    output: tool?.output ? String(tool.output).slice(0, 24_000) : undefined,
    todos: Array.isArray(tool?.todos)
      ? tool.todos.slice(0, 80).map((todo: any, todoIndex: number) => ({
          id: String(todo?.id ?? `todo-${todoIndex}`).slice(0, 120),
          content: String(todo?.content ?? "").slice(0, 1_000),
          status: TODO_STATUS.includes(todo?.status) ? todo.status : "pending",
        }))
      : undefined,
    files: sanitizeDesignFiles(tool?.files),
    state: TODO_STATUS.includes(tool?.state) ? tool.state : "complete",
  };
}

function sanitizeBlocks(raw: unknown): StoredChatMessage["blocks"] {
  if (!Array.isArray(raw)) return undefined;
  const blocks = raw
    .slice(0, 120)
    .map((block: any, index: number) => {
      if (block?.type === "text") {
        return { id: String(block?.id ?? `text-${index}`), type: "text" as const, text: String(block?.text ?? "").slice(0, 40_000) };
      }
      if (block?.type === "tool") {
        return { id: String(block?.id ?? `tool-${index}`), type: "tool" as const, tool: sanitizeTool(block?.tool, index) };
      }
      return null;
    })
    .filter(Boolean) as NonNullable<StoredChatMessage["blocks"]>;
  return blocks.length ? blocks : undefined;
}

function sanitizeTodos(raw: unknown): StoredGlobalTodo[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  return raw.slice(0, 200).map((todo: any, index: number) => ({
    id: String(todo?.id ?? `todo-${index}`).slice(0, 120),
    content: String(todo?.content ?? "").slice(0, 1_000),
    status: TODO_STATUS.includes(todo?.status) ? todo.status : "pending",
    group: todo?.group ? String(todo.group).slice(0, 200) : undefined,
    turnId: todo?.turnId ? String(todo.turnId).slice(0, 120) : undefined,
    ts: finiteNonNegative(todo?.ts),
  }));
}

function sanitizeMessages(raw: unknown): StoredChatMessage[] {
  return (Array.isArray(raw) ? raw : [])
    .filter((m: any) => m && (m.role === "user" || m.role === "assistant"))
    .map((m: any) => ({
      id: m.id ? String(m.id) : undefined,
      role: m.role,
      content: String(m.content ?? ""),
      ran: m.ran ? String(m.ran) : undefined,
      doc: m.doc && typeof m.doc === "object"
        ? {
            title: String(m.doc.title ?? "Presentation"),
            subtitle: String(m.doc.subtitle ?? ""),
            icon: m.doc.icon ? String(m.doc.icon) : undefined,
            artifactId: m.doc.artifactId ? String(m.doc.artifactId).slice(0, 120) : undefined,
            pages: Array.isArray(m.doc.pages)
              ? m.doc.pages.slice(0, 100).map((page: any) => ({
                  title: String(page?.title ?? ""),
                  points: Array.isArray(page?.points) ? page.points.map(String).slice(0, 20) : [],
                }))
              : undefined,
          }
        : undefined,
      artifact: m.artifact && typeof m.artifact === "object"
        ? {
            id: String(m.artifact.id ?? "").slice(0, 120),
            kind: ["questions", "outline", "inspiration"].includes(m.artifact.kind)
              ? m.artifact.kind
              : "outline",
            title: String(m.artifact.title ?? "Design file").slice(0, 160),
            subtitle: String(m.artifact.subtitle ?? "").slice(0, 240),
          }
        : undefined,
      attachment: m.attachment,
      contextItems: m.contextItems,
      designFiles: sanitizeDesignFiles(m.designFiles),
      contextOptions: Array.isArray(m.contextOptions)
        ? m.contextOptions.slice(0, 12).map((item: any, index: number) => ({
            id: String(item?.id ?? `option-${index}`),
            kind: ["research", "style", "setting", "speed", "scenario"].includes(item?.kind) ? item.kind : "setting",
            label: String(item?.label ?? "Option"),
            value: item?.value ? String(item.value) : undefined,
          }))
        : undefined,
      suggestions: Array.isArray(m.suggestions) ? m.suggestions.map(String) : undefined,
      process: m.process && typeof m.process === "object"
        ? {
            state: ["running", "complete", "error"].includes(m.process.state) ? m.process.state : "complete",
            title: String(m.process.title ?? "Agent activity"),
            notes: Array.isArray(m.process.notes) ? m.process.notes.map(String).slice(0, 12) : undefined,
            tools: Array.isArray(m.process.tools)
              ? m.process.tools.slice(0, 40).map((tool: any, index: number) => sanitizeTool(tool, index))
              : [],
          }
        : undefined,
      blocks: sanitizeBlocks(m.blocks),
      inspiration: m.inspiration && typeof m.inspiration === "object"
        ? {
            query: String(m.inspiration.query ?? ""),
            coverIds: Array.isArray(m.inspiration.coverIds)
              ? m.inspiration.coverIds.map(String).slice(0, 12)
              : [],
            total: finiteNonNegative(m.inspiration.total) ?? 0,
            chosen: m.inspiration.chosen ? String(m.inspiration.chosen) : undefined,
            resolved: Boolean(m.inspiration.resolved),
          }
        : undefined,
      usage: m.usage && typeof m.usage === "object"
        ? {
            inputTokens: finiteNonNegative(m.usage.inputTokens),
            outputTokens: finiteNonNegative(m.usage.outputTokens),
            totalTokens: finiteNonNegative(m.usage.totalTokens),
            costUsd: finiteNonNegative(m.usage.costUsd),
            model: m.usage.model ? String(m.usage.model).slice(0, 120) : undefined,
            estimated: Boolean(m.usage.estimated),
          }
        : undefined,
      ts: typeof m.ts === "number" ? m.ts : undefined,
    }))
    .slice(-200);
}

function sanitizeConversations(raw: unknown): StoredConversation[] {
  const now = Date.now();
  return (Array.isArray(raw) ? raw : [])
    .filter((conversation: any) => conversation && conversation.id)
    .slice(-50)
    .map((conversation: any, index: number) => {
      const createdAt = finiteNonNegative(conversation.createdAt) ?? now;
      return {
        id: String(conversation.id).slice(0, 120),
        title: String(conversation.title ?? `新会话 ${index + 1}`).trim().slice(0, 80) || `新会话 ${index + 1}`,
        createdAt,
        updatedAt: finiteNonNegative(conversation.updatedAt) ?? createdAt,
        messages: sanitizeMessages(conversation.messages),
        todos: sanitizeTodos(conversation.todos),
      };
    });
}

/** Persist one or many conversations so reopening the project restores the dialogue. */
export async function PUT(req: Request, { params: paramsPromise }: { params: Promise<{ id: string }> }) {
  const params = await paramsPromise;
  const body = await req.json().catch(() => ({}));
  const chat = sanitizeMessages(body?.messages);
  const conversations = sanitizeConversations(body?.conversations);
  // Read the project only after the request body has been consumed. Chat saves
  // run in the background and can overlap a structural slide edit; loading
  // before the await allowed an old page array to overwrite a just-inserted
  // slide when this PUT eventually reached saveProject().
  const project = loadProject(params.id);
  if (!project) return NextResponse.json({ error: "project not found" }, { status: 404 });
  const before = JSON.stringify({
    chat: project.chat ?? [],
    conversations: project.conversations ?? [],
    activeConversationId: project.activeConversationId ?? "",
  });
  if (conversations.length) {
    const requestedActiveId = String(body?.activeConversationId ?? "");
    const activeConversation = conversations.find((conversation) => conversation.id === requestedActiveId)
      ?? conversations[0];
    project.conversations = conversations;
    project.activeConversationId = activeConversation.id;
    project.chat = activeConversation.messages;
  } else {
    project.chat = chat;
    // A legacy client saving only `messages` should update the selected modern
    // conversation instead of silently discarding the multi-session history.
    if (project.conversations?.length) {
      const activeConversation = project.conversations.find(
        (conversation) => conversation.id === project.activeConversationId,
      ) ?? project.conversations[0];
      activeConversation.messages = chat;
      activeConversation.updatedAt = Date.now();
      project.activeConversationId = activeConversation.id;
    }
  }
  const changed = before !== JSON.stringify({
    chat: project.chat ?? [],
    conversations: project.conversations ?? [],
    activeConversationId: project.activeConversationId ?? "",
  });
  if (changed) saveProject(project);
  return NextResponse.json({
    ok: true,
    count: project.chat?.length ?? 0,
    conversations: project.conversations?.length ?? 0,
    activeConversationId: project.activeConversationId,
    changed,
  }, {
    headers: {
      "Cache-Control": "no-store",
      "X-Codex-Slides-Write": changed ? "saved" : "skipped",
    },
  });
}

/** Classify a natural-language edit into a plan. Execution happens via /regenerate. */
export async function POST(req: Request, { params: paramsPromise }: { params: Promise<{ id: string }> }) {
  const params = await paramsPromise;
  const body = await req.json().catch(() => ({}));
  const message = String(body?.message ?? "").trim();
  if (!message) return NextResponse.json({ error: "message required" }, { status: 400 });
  const project = loadProject(params.id);
  if (!project) return NextResponse.json({ error: "project not found" }, { status: 404 });
  try {
    const contextIndex = Math.trunc(Number(body?.context?.slideIndex));
    const context = Number.isInteger(contextIndex) && contextIndex >= 1 && contextIndex <= project.pages.length
      ? { slideIndex: contextIndex, title: String(body?.context?.title ?? "") }
      : undefined;
    const rawAttachmentIds: unknown[] = Array.isArray(body?.attachmentIds) ? body.attachmentIds : [];
    const attachmentIds: string[] = Array.from(
      new Set(rawAttachmentIds.map((id) => String(id))),
    ).slice(0, 8);
    const existingIds = new Set((project.materials ?? []).map((item) => item.id));
    const newRecords = attachMaterialsToProject(
      project.id,
      attachmentIds.filter((id) => !existingIds.has(id)),
    );
    if (newRecords.length) {
      project.materials = [...(project.materials ?? []), ...newRecords];
      project.config.materialIds = Array.from(new Set([
        ...(project.config.materialIds ?? []),
        ...newRecords.map((item) => item.id),
      ]));
      saveProject(project);
    }
    const turnRecords = (project.materials ?? []).filter((item) => attachmentIds.includes(item.id));
    const rawDesignFilePaths = Array.isArray(body?.designFilePaths)
      ? body.designFilePaths.map(String).slice(0, 12)
      : [];
    const attachmentDesignFilePaths = turnRecords
      .map((record) => record.designFilePath)
      .filter((value): value is string => Boolean(value));
    const { references: designFiles, attachments: designFileAttachments } = loadProjectFileReferences(
      project.id,
      [...attachmentDesignFilePaths, ...rawDesignFilePaths],
    );
    const attachments = [
      ...loadProjectInputAttachments(project.id, turnRecords),
      ...designFileAttachments,
    ];
    const plan = await planChatEdit(project, message, context, attachments, designFiles);
    return NextResponse.json({ plan, designFiles });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message ?? e) }, { status: 500 });
  }
}
