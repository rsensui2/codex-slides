import { randomUUID } from "node:crypto";
import {
  attachMaterialsToProject,
  loadProjectInputAttachments,
} from "./materials";
import { loadProjectFileReferences } from "./projectFiles";
import { planChatEdit } from "./chat";
import {
  currentDeckVersionSignature,
  ensureCurrentDeckVersion,
} from "./deckVersions";
import {
  markEditPage,
  regeneratePage,
  renderProject,
  reviseOutline,
} from "./pipeline";
import {
  loadProject,
  readSlideImage,
  replaceProjectPages,
  saveProject,
} from "./store";
import { createQueuedChatRequest, type QueuedChatRequest } from "./chatQueue";
import {
  isUiLocale,
  translate,
  type MessageKey,
  type MessageValues,
  type UiLocale,
} from "@/i18n/messages";
import type {
  Project,
  ProjectRunInput,
  ProjectRunRecord,
  ProjectRunState,
  SlidePage,
  StoredAgentTool,
  StoredChatMessage,
  StoredConversation,
} from "./types";

type StoredProcess = NonNullable<StoredChatMessage["process"]>;

interface RunningJob {
  id: string;
  controller: AbortController;
  promise: Promise<void>;
  heartbeat: ReturnType<typeof setInterval>;
}

interface StartRunResult {
  accepted: boolean;
  queued: boolean;
  project: Project;
  run?: ProjectRunState;
  queuedRequestId?: string;
}

const globalRuns = globalThis as typeof globalThis & {
  __codexSlidesProjectRuns?: Map<string, RunningJob>;
};

const jobs = globalRuns.__codexSlidesProjectRuns
  ?? (globalRuns.__codexSlidesProjectRuns = new Map<string, RunningJob>());

function localeOf(value: unknown): UiLocale {
  return isUiLocale(value) ? value : "ja";
}

function tr(locale: UiLocale, key: MessageKey, values: MessageValues = {}) {
  return translate(locale, key, values);
}

function runCopy(locale: UiLocale, zh: string, en: string, ja: string) {
  if (locale === "en") return en;
  if (locale === "ja") return ja;
  return zh;
}

function elapsed(startedAt: number, locale: UiLocale) {
  const seconds = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
  if (locale === "en") return `Ran for ${seconds}s`;
  if (locale === "ja") return `${seconds}秒で完了`;
  return `耗时 ${seconds} 秒`;
}

function runLabel(input: ProjectRunInput, locale: UiLocale) {
  if (input.kind === "outline") return tr(locale, "agent.revisingOutline");
  if (input.kind === "render") return tr(locale, "flow.renderingTitle");
  if (input.kind === "mark") {
    return tr(locale, "agent.editingSlide", { index: input.mark?.index ?? 0 });
  }
  return tr(locale, "agent.understanding");
}

function fileUrl(projectId: string, name: string, bust = Date.now()) {
  return `/api/files/${encodeURIComponent(projectId)}/${encodeURIComponent(name)}?v=${bust}`;
}

function groupLabel(message: string) {
  const oneLine = message.replace(/\s+/g, " ").trim();
  return oneLine.length > 40 ? `${oneLine.slice(0, 39)}…` : oneLine || "编辑";
}

function conversationTitle(message: string, fallback: string) {
  const oneLine = message.replace(/\s+/g, " ").trim();
  return (oneLine || fallback).slice(0, 80);
}

function ensureConversation(project: Project, input: ProjectRunInput): StoredConversation {
  const requestedId = input.conversationId || project.activeConversationId;
  const existing = project.conversations?.find((item) => item.id === requestedId);
  if (existing) return existing;

  const now = Date.now();
  const id = requestedId || `conversation-${randomUUID()}`;
  const conversation: StoredConversation = {
    id,
    title: conversationTitle(input.request?.message ?? input.mark?.note ?? "", project.title),
    createdAt: now,
    updatedAt: now,
    messages: project.conversations?.length ? [] : [...(project.chat ?? [])],
    todos: [],
  };
  project.conversations = [...(project.conversations ?? []), conversation];
  if (!project.activeConversationId) project.activeConversationId = id;
  return conversation;
}

function syncLegacyChat(project: Project, conversation: StoredConversation) {
  if (!project.activeConversationId) project.activeConversationId = conversation.id;
  if (project.activeConversationId === conversation.id) project.chat = conversation.messages;
}

function mutateConversation(
  projectId: string,
  input: ProjectRunInput,
  mutate: (conversation: StoredConversation, project: Project) => void,
) {
  const project = loadProject(projectId);
  if (!project) throw new Error("project not found");
  const conversation = ensureConversation(project, input);
  mutate(conversation, project);
  conversation.updatedAt = Date.now();
  syncLegacyChat(project, conversation);
  saveProject(project);
  return project;
}

function findAssistant(conversation: StoredConversation, runId: string) {
  return conversation.messages.find((message) => message.id === runId && message.role === "assistant");
}

function updateAssistant(
  projectId: string,
  run: ProjectRunState,
  update: (message: StoredChatMessage) => StoredChatMessage,
) {
  mutateConversation(projectId, run.input, (conversation) => {
    const index = conversation.messages.findIndex((message) => message.id === run.id);
    if (index < 0) return;
    conversation.messages[index] = update(conversation.messages[index]);
  });
}

function patchTool(process: StoredProcess, id: string, patch: Partial<StoredAgentTool>): StoredProcess {
  return {
    ...process,
    tools: process.tools.map((tool) => (tool.id === id ? { ...tool, ...patch } : tool)),
  };
}

function settleTools(process: StoredProcess, detail: string): StoredProcess {
  return {
    ...process,
    tools: process.tools.map((tool) => (
      tool.state === "running" || tool.state === "pending"
        ? { ...tool, state: "error", detail: detail || tool.detail }
        : tool
    )),
  };
}

function toolLabel(locale: UiLocale, kind: StoredAgentTool["kind"]) {
  if (kind === "bash") return tr(locale, "agent.runCommand");
  if (kind === "read") return tr(locale, "agent.readFile");
  if (kind === "write" || kind === "edit") return tr(locale, "agent.editFiles");
  if (kind === "search") return tr(locale, "agent.search");
  if (kind === "todo") return tr(locale, "agent.taskList");
  return tr(locale, "agent.useTool");
}

function initializeTranscript(projectId: string, run: ProjectRunState) {
  const locale = localeOf(run.input.locale);
  mutateConversation(projectId, run.input, (conversation) => {
    if (findAssistant(conversation, run.id)) return;

    const designFiles = run.input.request?.designFiles ?? [];
    if (run.input.kind === "chat" || run.input.kind === "outline") {
      const request = run.input.request!;
      conversation.messages.push({
        id: `${run.id}-user`,
        role: "user",
        content: request.message,
        attachment: request.context,
        contextItems: request.attachments,
        designFiles,
        ts: run.startedAt,
      });
    } else if (run.input.kind === "mark") {
      const mark = run.input.mark!;
      conversation.messages.push({
        id: `${run.id}-user`,
        role: "user",
        content: mark.note || tr(locale, "agent.markRequest", { index: mark.index }),
        attachment: {
          slideIndex: mark.index,
          title: `${mark.title || tr(locale, "chat.slide", { index: mark.index })} · ${tr(locale, "agent.visualMark")}`,
          imageUrl: fileUrl(projectId, mark.source, run.startedAt),
        },
        ts: run.startedAt,
      });
    }

    let process: StoredProcess;
    if (run.input.kind === "render") {
      const total = Math.max(0, run.progress?.total ?? 0);
      process = {
        state: "running",
        title: tr(locale, "flow.renderingTitle"),
        notes: [tr(locale, "flow.renderingNote")],
        tools: [{
          id: "render",
          name: "render_deck",
          label: tr(locale, "flow.renderTool"),
          detail: `0 / ${total}`,
          state: "running",
        }],
      };
    } else if (run.input.kind === "mark") {
      const index = run.input.mark?.index ?? 0;
      process = {
        state: "running",
        title: tr(locale, "agent.editingSlide", { index }),
        notes: [tr(locale, "agent.markNoteOne"), tr(locale, "agent.markNoteTwo")],
        tools: [{
          id: "mark-edit",
          name: "mark_edit_page",
          label: tr(locale, "agent.applyVisual"),
          detail: tr(locale, "agent.processMark", { index }),
          state: "running",
        }],
      };
    } else if (run.input.kind === "outline") {
      process = {
        state: "running",
        title: tr(locale, "agent.revisingOutline"),
        notes: [tr(locale, "agent.revisingOutlineNote")],
        tools: [
          ...designFiles.map((file, index) => ({
            id: `read-${index}`,
            name: "read",
            kind: "read" as const,
            label: tr(locale, "agent.readDesignFile"),
            detail: file.relativePath,
            path: file.path,
            relativePath: file.relativePath,
            state: "running" as const,
          })),
          {
            id: "revise-outline",
            name: "revise_outline",
            kind: "edit" as const,
            label: tr(locale, "agent.reviseOutline"),
            detail: tr(locale, "agent.reviseOutlineDetail"),
            state: "running" as const,
          },
        ],
      };
    } else {
      process = {
        state: "running",
        title: tr(locale, "agent.understanding"),
        notes: [tr(locale, "agent.understandingNote")],
        tools: [
          ...designFiles.map((file, index) => ({
            id: `read-${index}`,
            name: "read",
            kind: "read" as const,
            label: tr(locale, "agent.readDesignFile"),
            detail: file.relativePath,
            path: file.path,
            relativePath: file.relativePath,
            state: "running" as const,
          })),
          {
            id: "plan",
            name: "plan_deck_edit",
            kind: "tool" as const,
            label: tr(locale, "agent.plan"),
            detail: tr(locale, "agent.planDetail"),
            state: "running" as const,
          },
        ],
      };
    }

    conversation.messages.push({
      id: run.id,
      role: "assistant",
      content: run.input.kind === "render"
        ? tr(locale, "flow.render", { count: run.progress?.total ?? 0 })
        : "",
      process,
      ts: run.startedAt,
    });
  });
}

function patchActiveRun(projectId: string, runId: string, patch: Partial<ProjectRunState>) {
  const project = loadProject(projectId);
  if (!project?.activeRun || project.activeRun.id !== runId) return project;
  project.activeRun = {
    ...project.activeRun,
    ...patch,
    id: project.activeRun.id,
    updatedAt: Date.now(),
  };
  saveProject(project);
  return project;
}

function archiveRun(
  projectId: string,
  run: ProjectRunState,
  status: ProjectRunRecord["status"],
  error?: string,
) {
  const project = loadProject(projectId);
  if (!project) return null;
  const completedAt = Date.now();
  const latest = project.activeRun?.id === run.id ? project.activeRun : run;
  const record: ProjectRunRecord = {
    ...latest,
    status,
    updatedAt: completedAt,
    completedAt,
    ...(error ? { error } : {}),
  };
  project.runHistory = [
    record,
    ...(project.runHistory ?? []).filter((item) => item.id !== run.id),
  ].slice(0, 40);
  if (project.activeRun?.id === run.id) project.activeRun = undefined;
  saveProject(project);
  return record;
}

function throwIfStopped(projectId: string, runId: string, signal: AbortSignal) {
  const current = loadProject(projectId)?.activeRun;
  if (signal.aborted || !current || current.id !== runId || current.status === "stopping") {
    throw new Error("aborted");
  }
}

function prepareTurn(projectId: string, run: ProjectRunState) {
  const request = run.input.request!;
  let project = loadProject(projectId);
  if (!project) throw new Error("project not found");
  const attachmentIds = Array.from(new Set((request.attachments ?? []).map((item) => item.id))).slice(0, 8);
  const existingIds = new Set((project.materials ?? []).map((item) => item.id));
  const added = attachMaterialsToProject(
    project.id,
    attachmentIds.filter((id) => !existingIds.has(id)),
  );
  if (added.length) {
    project.materials = [...(project.materials ?? []), ...added];
    project.config.materialIds = Array.from(new Set([
      ...(project.config.materialIds ?? []),
      ...added.map((item) => item.id),
    ]));
    saveProject(project);
    project = loadProject(projectId)!;
  }
  const records = (project.materials ?? []).filter((item) => attachmentIds.includes(item.id));
  const { references, attachments: fileAttachments } = loadProjectFileReferences(
    projectId,
    (request.designFiles ?? []).map((file) => file.path),
  );
  return {
    project,
    designFiles: references,
    attachments: [
      ...loadProjectInputAttachments(projectId, records),
      ...fileAttachments,
    ],
  };
}

function addBlankSlide(projectId: string, afterIndex: number, title?: string) {
  const project = loadProject(projectId);
  if (!project) throw new Error("project not found");
  const insertAt = Math.max(0, Math.min(project.pages.length, Math.trunc(afterIndex)));
  const page: SlidePage = {
    index: insertAt + 1,
    title: title?.trim().slice(0, 80) || `Slide ${insertAt + 1}`,
    points: [],
    status: "pending",
  };
  const pages = [...project.pages];
  pages.splice(insertAt, 0, page);
  replaceProjectPages(project, pages);
  return insertAt + 1;
}

async function runChat(projectId: string, run: ProjectRunState, signal: AbortSignal) {
  const locale = localeOf(run.input.locale);
  const request = run.input.request!;
  const turn = prepareTurn(projectId, run);
  const plan = await planChatEdit(
    turn.project,
    request.message,
    request.context,
    turn.attachments,
    turn.designFiles,
    signal,
  );
  throwIfStopped(projectId, run.id, signal);

  const planDetail = plan.action === "edit"
    ? tr(locale, plan.targets.length === 1 ? "agent.targetOne" : "agent.targetMany", { targets: plan.targets.join(", ") })
    : plan.action === "add"
      ? tr(locale, "agent.addRender")
      : tr(locale, "agent.replyOnly");
  const activities: StoredAgentTool[] = (plan.activities ?? []).map((tool, index) => ({
    ...tool,
    id: `cli-${tool.id || index}`,
    label: toolLabel(locale, tool.kind),
  }));
  updateAssistant(projectId, run, (current) => {
    let process = current.process!;
    process = {
      ...process,
      tools: [
        ...process.tools.map((tool) => (tool.kind === "read" ? { ...tool, state: "complete" as const } : tool)),
        ...activities,
      ],
    };
    process = patchTool(process, "plan", { state: "complete", detail: planDetail });
    return {
      ...current,
      process: {
        ...process,
        title: plan.action === "add"
          ? tr(locale, "agent.adding")
          : plan.action === "edit"
            ? tr(locale, "agent.applying")
            : tr(locale, "agent.reviewed"),
        notes: plan.instruction
          ? [tr(locale, "agent.plannedChange", { instruction: plan.instruction })]
          : [tr(locale, "agent.noChange")],
      },
    };
  });

  if (plan.action === "answer") {
    updateAssistant(projectId, run, (current) => ({
      ...current,
      content: plan.reply,
      ran: elapsed(run.startedAt, locale),
      process: { ...current.process!, state: "complete", title: tr(locale, "agent.reviewed") },
    }));
    return;
  }

  if (plan.action === "add") {
    const afterIndex = plan.afterIndex ?? turn.project.pages.length;
    updateAssistant(projectId, run, (current) => ({
      ...current,
      process: {
        ...current.process!,
        tools: [
          ...current.process!.tools,
          {
            id: "add",
            name: "add_slide",
            kind: "write",
            label: tr(locale, "agent.insert"),
            detail: tr(locale, "agent.after", { index: afterIndex }),
            state: "running",
          },
          {
            id: "generate",
            name: "generate_slide",
            kind: "edit",
            label: tr(locale, "agent.renderSlide"),
            detail: tr(locale, "agent.matchStyle"),
            state: "pending",
          },
        ],
      },
    }));
    const insertedIndex = addBlankSlide(projectId, afterIndex, plan.title);
    patchActiveRun(projectId, run.id, {
      label: tr(locale, "agent.adding"),
      detail: tr(locale, "agent.renderingSlide", { index: insertedIndex }),
      targetSlide: insertedIndex,
    });
    updateAssistant(projectId, run, (current) => ({
      ...current,
      process: patchTool(
        patchTool(current.process!, "add", {
          state: "complete",
          detail: tr(locale, "agent.inserted", { index: insertedIndex }),
        }),
        "generate",
        { state: "running", detail: tr(locale, "agent.renderingSlide", { index: insertedIndex }) },
      ),
    }));
    const page = await regeneratePage(
      projectId,
      insertedIndex,
      plan.instruction || request.message,
      plan.title,
      signal,
    );
    throwIfStopped(projectId, run.id, signal);
    updateAssistant(projectId, run, (current) => ({
      ...current,
      content: tr(locale, "agent.addedReply", { reply: plan.reply, index: insertedIndex }),
      ran: elapsed(run.startedAt, locale),
      attachment: {
        slideIndex: insertedIndex,
        title: page.title || tr(locale, "chat.slide", { index: insertedIndex }),
        imageUrl: fileUrl(projectId, page.image!, Date.now()),
      },
      process: {
        ...patchTool(current.process!, "generate", {
          state: "complete",
          detail: tr(locale, "agent.renderedSlide", { index: insertedIndex }),
        }),
        state: "complete",
        title: tr(locale, "agent.addedSlide", { index: insertedIndex }),
      },
    }));
    return;
  }

  if (!plan.targets.length) {
    updateAssistant(projectId, run, (current) => ({
      ...current,
      content: plan.reply || tr(locale, "agent.noChange"),
      ran: elapsed(run.startedAt, locale),
      process: { ...current.process!, state: "complete", title: tr(locale, "agent.reviewed") },
    }));
    return;
  }

  updateAssistant(projectId, run, (current) => ({
    ...current,
    process: {
      ...current.process!,
      tools: [
        ...current.process!.tools,
        {
          id: "edit-todos",
          name: "todo_write",
          kind: "todo",
          label: tr(locale, "agent.editChecklist"),
          detail: tr(locale, "agent.editChecklistDetail", { count: plan.targets.length }),
          state: "running",
          todos: plan.targets.map((target) => ({
            id: `slide-${target}`,
            content: tr(locale, "agent.updateSlide", { index: target }),
            status: "pending",
          })),
        },
        ...plan.targets.map((target) => ({
          id: `regenerate-${target}`,
          name: "regenerate_slide",
          kind: "edit" as const,
          label: tr(locale, "agent.updateSlide", { index: target }),
          detail: tr(locale, "agent.waitPrevious"),
          state: "pending" as const,
        })),
      ],
    },
  }));

  const failed: number[] = [];
  let lastAttachment: StoredChatMessage["attachment"];
  for (let position = 0; position < plan.targets.length; position += 1) {
    if (signal.aborted) throw new Error("aborted");
    const target = plan.targets[position];
    patchActiveRun(projectId, run.id, {
      label: tr(locale, "agent.applying"),
      detail: tr(locale, "agent.updateSlide", { index: target }),
      targetSlide: target,
      progress: { current: position, total: plan.targets.length },
    });
    updateAssistant(projectId, run, (current) => {
      let process = patchTool(current.process!, `regenerate-${target}`, {
        state: "running",
        detail: tr(locale, "agent.redrawing"),
      });
      const todo = process.tools.find((tool) => tool.id === "edit-todos");
      process = patchTool(process, "edit-todos", {
        todos: todo?.todos?.map((item) => (
          item.id === `slide-${target}` ? { ...item, status: "in_progress" } : item
        )),
      });
      return { ...current, process };
    });
    try {
      const page = await regeneratePage(
        projectId,
        target,
        plan.instruction,
        plan.targets.length === 1 ? plan.title : undefined,
        signal,
      );
      throwIfStopped(projectId, run.id, signal);
      lastAttachment = {
        slideIndex: target,
        title: page.title || tr(locale, "chat.slide", { index: target }),
        imageUrl: fileUrl(projectId, page.image!, Date.now()),
      };
      updateAssistant(projectId, run, (current) => {
        let process = patchTool(current.process!, `regenerate-${target}`, {
          state: "complete",
          detail: tr(locale, "agent.updatedSlide", { index: target }),
        });
        const todo = process.tools.find((tool) => tool.id === "edit-todos");
        process = patchTool(process, "edit-todos", {
          todos: todo?.todos?.map((item) => (
            item.id === `slide-${target}` ? { ...item, status: "complete" } : item
          )),
        });
        return { ...current, process };
      });
    } catch (error: any) {
      if (signal.aborted) throw error;
      failed.push(target);
      updateAssistant(projectId, run, (current) => {
        let process = patchTool(current.process!, `regenerate-${target}`, {
          state: "error",
          detail: String(error?.message ?? error),
        });
        const todo = process.tools.find((tool) => tool.id === "edit-todos");
        process = patchTool(process, "edit-todos", {
          todos: todo?.todos?.map((item) => (
            item.id === `slide-${target}` ? { ...item, status: "error" } : item
          )),
        });
        return { ...current, process };
      });
    }
  }

  patchActiveRun(projectId, run.id, { progress: { current: plan.targets.length, total: plan.targets.length } });
  updateAssistant(projectId, run, (current) => ({
    ...current,
    content: failed.length
      ? tr(locale, "agent.partialFailure", { reply: plan.reply, targets: failed.join(", ") })
      : tr(locale, "agent.updatedReply", { reply: plan.reply, targets: plan.targets.join(", ") }),
    ran: elapsed(run.startedAt, locale),
    attachment: lastAttachment,
    process: {
      ...patchTool(current.process!, "edit-todos", { state: failed.length ? "error" : "complete" }),
      state: failed.length ? "error" : "complete",
      title: failed.length ? tr(locale, "agent.editErrors") : tr(locale, "agent.editComplete"),
    },
  }));
}

async function runOutline(projectId: string, run: ProjectRunState, signal: AbortSignal) {
  const locale = localeOf(run.input.locale);
  const request = run.input.request!;
  const turn = prepareTurn(projectId, run);
  const result = await reviseOutline(projectId, request.message, {
    signal,
    attachments: turn.attachments,
    designFiles: turn.designFiles,
  });
  throwIfStopped(projectId, run.id, signal);
  updateAssistant(projectId, run, (current) => ({
    ...current,
    content: result.reply || tr(locale, "flow.outlineUpdated"),
    ran: elapsed(run.startedAt, locale),
    process: {
      ...patchTool({
        ...current.process!,
        tools: current.process!.tools.map((tool) => (
          tool.kind === "read" ? { ...tool, state: "complete" as const } : tool
        )),
      }, "revise-outline", {
        state: "complete",
        detail: tr(locale, "agent.outlineRevised", { count: result.pages.length }),
      }),
      state: "complete",
      title: tr(locale, "agent.outlineComplete"),
    },
  }));
}

async function runRender(projectId: string, run: ProjectRunState, signal: AbortSignal) {
  const locale = localeOf(run.input.locale);
  let rendered = loadProject(projectId)?.pages.filter((page) => page.status === "rendered").length ?? 0;
  let failed = 0;
  const total = loadProject(projectId)?.pages.length ?? 0;
  await renderProject(projectId, (event) => {
    if (event.type === "page_rendered") rendered += 1;
    if (event.type === "page_error") failed += 1;
    // The verify sweep is authoritative: it recomputes counts from live page
    // state, correcting the running tally once retried pages flip back to done.
    if (event.type === "verify") {
      rendered = event.rendered;
      failed = event.pending;
    }
    if (
      event.type !== "page_start" &&
      event.type !== "page_rendered" &&
      event.type !== "page_error" &&
      event.type !== "page_retry" &&
      event.type !== "verify"
    ) return;
    const target = "index" in event ? event.index : undefined;
    const detail = event.type === "page_retry"
      ? tr(locale, "flow.retrying", { index: event.index, attempt: event.attempt + 1, total: event.maxAttempts })
      : event.type === "verify"
        ? event.phase === "done"
          ? tr(locale, "flow.verifyDone", { rendered: event.rendered, total: event.total })
          : tr(locale, "flow.verifying", { pending: event.pending, total: event.total })
        : event.type === "page_start"
          ? `${rendered} / ${total} · ${tr(locale, "flow.renderingSlide", { index: event.index })}`
          : `${rendered} / ${total}${failed ? ` · ${tr(locale, "flow.failedCount", { count: failed })}` : ""}`;
    patchActiveRun(projectId, run.id, {
      detail,
      targetSlide: target,
      progress: { current: rendered, total },
    });
    updateAssistant(projectId, run, (current) => ({
      ...current,
      process: patchTool(current.process!, "render", { state: "running", detail }),
    }));
  }, { signal });
  throwIfStopped(projectId, run.id, signal);
  updateAssistant(projectId, run, (current) => ({
    ...current,
    content: `${current.content}\n\n${tr(locale, "flow.renderDone", { count: rendered })}`,
    ran: elapsed(run.startedAt, locale),
    suggestions: rendered > 0 ? [
      tr(locale, "flow.suggestionSummary"),
      tr(locale, "flow.suggestionBusiness"),
      tr(locale, "flow.suggestionCover"),
      tr(locale, "flow.suggestionSpecific"),
    ] : undefined,
    process: {
      ...patchTool(current.process!, "render", {
        state: failed ? "error" : "complete",
        detail: `${rendered} / ${total}${failed ? ` · ${tr(locale, "flow.failedCount", { count: failed })}` : ""}`,
      }),
      state: failed ? "error" : "complete",
      title: failed ? tr(locale, "flow.renderFinishedWithErrors") : tr(locale, "flow.renderFinished"),
    },
  }));
}

async function runMark(projectId: string, run: ProjectRunState, signal: AbortSignal) {
  const locale = localeOf(run.input.locale);
  const mark = run.input.mark!;
  const bytes = readSlideImage(projectId, mark.source);
  if (!bytes) throw new Error("annotated image not found");
  const page = await markEditPage(projectId, mark.index, bytes, mark.note, signal);
  throwIfStopped(projectId, run.id, signal);
  updateAssistant(projectId, run, (current) => ({
    ...current,
    content: tr(locale, "agent.markApplied", { index: mark.index }),
    ran: elapsed(run.startedAt, locale),
    attachment: {
      slideIndex: mark.index,
      title: `${page.title || mark.title || tr(locale, "chat.slide", { index: mark.index })} · ${tr(locale, "agent.updated")}`,
      imageUrl: fileUrl(projectId, page.image!, Date.now()),
    },
    process: {
      ...patchTool(current.process!, "mark-edit", {
        state: "complete",
        detail: tr(locale, "agent.updatedSaved"),
      }),
      state: "complete",
      title: tr(locale, "agent.updatedSlide", { index: mark.index }),
    },
  }));
}

function failTranscript(projectId: string, run: ProjectRunState, error: unknown, stopped: boolean) {
  const locale = localeOf(run.input.locale);
  const detail = stopped
    ? runCopy(locale, "已手动终止", "Stopped manually", "手動で停止しました")
    : String((error as any)?.message ?? error);
  updateAssistant(projectId, run, (current) => ({
    ...current,
    content: stopped ? detail : `⚠ ${detail}`,
    ran: elapsed(run.startedAt, locale),
    process: {
      ...settleTools(current.process!, detail),
      state: "error",
      title: stopped
        ? runCopy(locale, "任务已终止", "Task stopped", "タスクを停止しました")
        : runCopy(locale, "任务失败", "Task failed", "タスクに失敗しました"),
    },
  }));
}

function settleStoppedProject(projectId: string, kind: ProjectRunInput["kind"]) {
  if (kind !== "render") return;
  const project = loadProject(projectId);
  if (!project) return;
  project.status = project.pages.some((page) => page.status === "rendered") ? "ready" : "draft";
  project.workflow = { ...(project.workflow ?? { stage: "deck" }), stage: "deck" };
  saveProject(project);
}

async function executeProjectRun(projectId: string, run: ProjectRunState, controller: AbortController) {
  let stopped = false;
  let finalStatus: ProjectRunRecord["status"] = "complete";
  let finalError = "";
  const before = loadProject(projectId);
  const beforeSignature = before ? currentDeckVersionSignature(before) : "";
  try {
    if (run.input.kind === "outline") await runOutline(projectId, run, controller.signal);
    else if (run.input.kind === "render") await runRender(projectId, run, controller.signal);
    else if (run.input.kind === "mark") await runMark(projectId, run, controller.signal);
    else await runChat(projectId, run, controller.signal);
    const latest = loadProject(projectId);
    if (latest && currentDeckVersionSignature(latest) !== beforeSignature) {
      const prompt = run.input.kind === "render"
        ? latest.config.requirement
        : run.input.kind === "mark"
          ? run.input.mark?.note
          : run.input.request?.message;
      await ensureCurrentDeckVersion(latest, {
        prompt,
        promptSource: run.input.kind === "render" ? "project" : "message",
        source: "ai",
        label: run.input.kind === "render"
          ? "Generated deck"
          : run.input.kind === "mark"
            ? `Marked slide ${run.input.mark?.index ?? ""}`.trim()
            : "Deck Agent edit",
        groupId: run.id,
      });
    }
  } catch (error) {
    const persistedRun = loadProject(projectId)?.activeRun;
    stopped = controller.signal.aborted
      || (persistedRun?.id === run.id && persistedRun.status === "stopping");
    failTranscript(projectId, run, error, stopped);
    finalStatus = stopped ? "cancelled" : "error";
    finalError = stopped ? "Stopped manually" : String((error as any)?.message ?? error);
    if (stopped) settleStoppedProject(projectId, run.input.kind);
  } finally {
    archiveRun(projectId, run, finalStatus, finalError || undefined);
    const job = jobs.get(projectId);
    if (job?.id === run.id) clearInterval(job.heartbeat);
    jobs.delete(projectId);
    if (!stopped) queueMicrotask(() => { void startNextQueuedRun(projectId, run.input.locale); });
  }
}

function launchRun(projectId: string, run: ProjectRunState, initialize: boolean) {
  if (jobs.has(projectId)) return;
  const controller = new AbortController();
  if (initialize) initializeTranscript(projectId, run);
  // Persist liveness less aggressively than UI progress. Real step changes save
  // immediately; this heartbeat only protects recovery after a worker restart.
  const heartbeat = setInterval(() => {
    const active = loadProject(projectId)?.activeRun;
    if (!active || active.id !== run.id || active.status === "stopping") {
      controller.abort();
      return;
    }
    patchActiveRun(projectId, run.id, {});
  }, 5000);
  const promise = Promise.resolve().then(() => executeProjectRun(projectId, run, controller));
  jobs.set(projectId, { id: run.id, controller, promise, heartbeat });
}

async function startNextQueuedRun(projectId: string, localeValue?: string) {
  const project = loadProject(projectId);
  if (!project || project.activeRun || jobs.has(projectId)) return;
  const queue = (project.workflow?.queuedRequests ?? []) as QueuedChatRequest[];
  const next = queue[0];
  if (!next?.message || !next.conversationId) return;
  project.workflow = {
    ...(project.workflow ?? { stage: "deck" }),
    queuedRequests: queue.slice(1),
  };
  saveProject(project);
  const latest = loadProject(projectId)!;
  const kind: ProjectRunInput["kind"] = latest.workflow?.stage === "outline" ? "outline" : "chat";
  startProjectRun(projectId, {
    kind,
    conversationId: next.conversationId,
    locale: localeValue,
    request: {
      message: next.message,
      context: next.context,
      attachments: next.attachments,
      designFiles: next.designFiles,
    },
  });
}

export function sanitizeProjectRunInput(raw: any): ProjectRunInput | null {
  const kind = ["chat", "outline", "render", "mark"].includes(String(raw?.kind))
    ? String(raw.kind) as ProjectRunInput["kind"]
    : null;
  if (!kind) return null;
  const conversationId = String(raw?.conversationId ?? "").trim().slice(0, 120) || undefined;
  const locale = isUiLocale(raw?.locale) ? raw.locale : "ja";
  if (kind === "render") return { kind, conversationId, locale };
  if (kind === "mark") {
    const index = Math.trunc(Number(raw?.mark?.index));
    const source = String(raw?.mark?.source ?? "").trim();
    if (!Number.isInteger(index) || index < 1 || !/^mark-[\w.-]+\.png$/i.test(source)) return null;
    return {
      kind,
      conversationId,
      locale,
      mark: {
        index,
        source,
        note: String(raw?.mark?.note ?? "").trim().slice(0, 8_000),
        title: String(raw?.mark?.title ?? "").trim().slice(0, 160) || undefined,
      },
    };
  }
  const message = String(raw?.request?.message ?? "").trim().slice(0, 40_000);
  if (!message) return null;
  const attachments = (Array.isArray(raw?.request?.attachments) ? raw.request.attachments : [])
    .slice(0, 8)
    .map((item: any) => ({
      id: String(item?.id ?? "").slice(0, 160),
      name: String(item?.name ?? "file").slice(0, 240),
      url: String(item?.url ?? "").slice(0, 2_000),
      kind: item?.kind === "image" ? "image" as const : "file" as const,
      mimeType: String(item?.mimeType ?? "application/octet-stream").slice(0, 160),
      size: Math.max(0, Number(item?.size) || 0),
    }))
    .filter((item: { id: string }) => item.id);
  const designFiles = (Array.isArray(raw?.request?.designFiles) ? raw.request.designFiles : [])
    .slice(0, 12)
    .map((file: any) => ({
      path: String(file?.path ?? "").slice(0, 2_000),
      relativePath: String(file?.relativePath ?? "").slice(0, 500),
      name: String(file?.name ?? "").slice(0, 240),
      kind: file?.kind,
    }))
    .filter((file: { path: string; relativePath: string; name: string }) => file.path && file.relativePath && file.name);
  const slideIndex = Math.trunc(Number(raw?.request?.context?.slideIndex));
  const context = Number.isInteger(slideIndex) && slideIndex > 0
    ? {
        slideIndex,
        title: String(raw?.request?.context?.title ?? "").slice(0, 240),
        imageUrl: String(raw?.request?.context?.imageUrl ?? "").slice(0, 2_000) || undefined,
      }
    : undefined;
  return {
    kind,
    conversationId,
    locale,
    request: { message, context, attachments, designFiles },
  };
}

export function startProjectRun(projectId: string, input: ProjectRunInput): StartRunResult {
  let project = ensureProjectRun(projectId);
  if (!project) throw new Error("project not found");

  if (project.activeRun || jobs.has(projectId)) {
    if (project.activeRun?.status === "stopping") {
      return { accepted: false, queued: false, project };
    }
    if ((input.kind === "chat" || input.kind === "outline") && input.request?.message) {
      const queued = createQueuedChatRequest(
        input.conversationId || project.activeConversationId || `conversation-${randomUUID()}`,
        input.request,
      );
      const currentQueue = (project.workflow?.queuedRequests ?? []) as QueuedChatRequest[];
      project.workflow = {
        ...(project.workflow ?? { stage: "deck" }),
        queuedRequests: [...currentQueue, queued].slice(-20),
      };
      saveProject(project);
      return { accepted: true, queued: true, project, queuedRequestId: queued.id };
    }
    return { accepted: false, queued: false, project };
  }

  const now = Date.now();
  const total = input.kind === "render" ? project.pages.length : undefined;
  const run: ProjectRunState = {
    id: `run-${randomUUID()}`,
    kind: input.kind,
    status: "running",
    conversationId: input.conversationId,
    label: runLabel(input, localeOf(input.locale)),
    detail: input.kind === "render" && total != null ? `0 / ${total}` : undefined,
    targetSlide: input.kind === "mark" ? input.mark?.index : undefined,
    progress: total != null ? { current: 0, total } : undefined,
    startedAt: now,
    updatedAt: now,
    input,
  };
  project.activeRun = run;
  saveProject(project);
  launchRun(projectId, run, true);
  project = loadProject(projectId)!;
  return { accepted: true, queued: false, project, run };
}

export function ensureProjectRun(projectId: string): Project | null {
  const project = loadProject(projectId);
  if (!project?.activeRun) return project;
  const age = Date.now() - project.activeRun.updatedAt;
  if (project.activeRun.status === "stopping") {
    if (jobs.has(projectId) || age < 15_000) return project;
    const run = project.activeRun;
    failTranscript(projectId, run, new Error("stopped manually"), true);
    settleStoppedProject(projectId, run.input.kind);
    archiveRun(projectId, run, "cancelled", "Stopped manually");
    return loadProject(projectId);
  }
  // Route handlers can run in separate Next worker contexts. A fresh on-disk
  // heartbeat means another worker still owns this run; do not launch a clone.
  if (!jobs.has(projectId) && age < 30_000) {
    return project;
  }
  if (!jobs.has(projectId)) launchRun(projectId, project.activeRun, false);
  return loadProject(projectId);
}

export function stopProjectRun(projectId: string, runId?: string): Project | null {
  const project = loadProject(projectId);
  if (!project?.activeRun) return project;
  const run = project.activeRun;
  if (runId && run.id !== runId) return project;
  project.activeRun = { ...run, status: "stopping", updatedAt: Date.now() };
  project.workflow = {
    ...(project.workflow ?? { stage: "deck" }),
    queuedRequests: [],
  };
  saveProject(project);
  const job = jobs.get(projectId);
  if (job?.id === run.id) {
    job.controller.abort();
  }
  return loadProject(projectId);
}

export function hasProjectRun(projectId: string) {
  return jobs.has(projectId);
}

export function getProjectRun(project: Project, runId?: string) {
  if (!runId) return project.activeRun ?? project.runHistory?.[0] ?? null;
  if (project.activeRun?.id === runId) return project.activeRun;
  return project.runHistory?.find((run) => run.id === runId) ?? null;
}
