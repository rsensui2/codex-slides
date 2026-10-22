"use client";

import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { ClockCounterClockwise } from "@phosphor-icons/react";
import ChatColumn, { type ChatMsg } from "@/components/ChatColumn";
import Composer from "@/components/Composer";
import Community from "@/components/Community";
import CodexTutorial from "@/components/CodexTutorial";
import DesignFilesPanel from "@/components/DesignFilesPanel";
import DeckVersionDialog from "@/components/DeckVersionDialog";
import HomeLibrary from "@/components/HomeLibrary";
import InspirationStage from "@/components/InspirationStage";
import OnboardForm from "@/components/OnboardForm";
import OutlineBoard from "@/components/OutlineBoard";
import ProjectLoadingShell from "@/components/ProjectLoadingShell";
import ResearchStage from "@/components/ResearchStage";
import InspireDialog from "@/components/InspireDialog";
import ScenarioPicker from "@/components/ScenarioPicker";
import SlideStage, { type MarkAgentEvent } from "@/components/SlideStage";
import TopBar from "@/components/TopBar";
import WorkspaceModeTabs from "@/components/WorkspaceModeTabs";
import {
  addProjectSlide,
  cacheProjectCheckpoint,
  createProjectCheckpoint,
  deriveStatus,
  fileUrl,
  generateSingleSlide,
  planChatEdit,
  readProjectCheckpointCache,
  regenerateSlide,
  patchProjectStyle,
  reviseOutlineChat,
  saveConversations,
  saveOutline,
  saveProjectCheckpoint,
  startProjectRun as startDetachedProjectRun,
  streamOnboard,
  streamOutline,
  type ChatRequest,
  type GenStatus,
  type ProjectCheckpointPatch,
  type SlideChatContext,
  type UiSlide,
} from "@/lib/deckEdit";
import { mergeContextItems, type ContextItem } from "@/lib/contextItems";
import {
  getScenario,
  isScenarioStarter,
  scenarioText,
  type PresentationScenario,
} from "@/lib/scenarios";
import type { QuestionSpec } from "@/lib/onboard";
import { ensureRequiredOnboardQuestions } from "@/lib/questionSemantics";
import { getTemplate } from "@/lib/templates";
import {
  COMMUNITY_TEMPLATES,
  getCommunityTemplate,
  inspireQueryFor,
  matchCommunityTemplates,
} from "@/lib/community";
import {
  DEFAULT_CONFIG,
  type ClarifyFormState,
  type ContextOptionItem,
  type OutlinePage,
  type PptConfig,
  type ProgressEvent,
  type Project,
  type ProjectTemplateSummary,
  type ResearchProgress,
} from "@/lib/types";
import {
  createAgentRunId,
  elapsedRunLabel,
  patchAgentTool,
  patchBlockTool,
  stopRunningTools,
  upsertBlock,
  type MessageBlock,
} from "@/lib/agentActivity";
import { outlineSnapshotMessage, styleSnapshotMessage } from "@/lib/chatArtifacts";
import {
  createQueuedChatRequest,
  loadQueuedChatRequests,
  prioritizeQueuedChatRequest,
  reorderConversationQueue,
  saveQueuedChatRequests,
  snapshotChatRequest,
  updateQueuedChatRequest,
  type QueuedChatRequest,
} from "@/lib/chatQueue";
import { useChatConversations } from "@/lib/useChatConversations";
import { runChatTurn } from "@/lib/chatTurn";
import { buildWorkflowProgress } from "@/lib/workflowProgress";
import { shouldResumeResearch } from "@/lib/workflowResume";
import { createResearchProgress, reduceResearchProgress } from "@/lib/researchProgress";
import { checkpointSignature } from "@/lib/projectSync";
import type { DesignFile, WorkspaceMode } from "@/lib/designFiles";
import { useI18n } from "@/i18n/I18nProvider";

interface EngineInfo {
  engine: string;
  label: string;
  available: boolean;
}

/** Full chain: idle (launcher) → work. Within work the right pane walks
 *  clarify → outline → deck, so there is no separate full-page step. */
type Phase = "idle" | "work";
type Stage = "clarify" | "outline" | "inspire" | "deck";

function checkpointMaterials(project: Project): ContextItem[] {
  return (project.materials ?? []).map((material) => ({
    id: material.id,
    name: material.name,
    url: `/api/projects/${encodeURIComponent(project.id)}/materials/${encodeURIComponent(material.file)}`,
    kind: material.kind === "file" ? "file" : "image",
    mimeType: material.mimeType ?? (material.kind === "image" ? "image/png" : "application/octet-stream"),
    size: material.size ?? 0,
  }));
}

export default function Home() {
  return <Suspense fallback={null}><HomeContent /></Suspense>;
}

function HomeContent() {
  const { locale, t } = useI18n();
  const searchParams = useSearchParams();
  const resumeId = searchParams?.get("resume")?.trim() ?? "";
  const continuationParams = new URLSearchParams(searchParams?.toString() ?? "");
  continuationParams.delete("resume");
  const resumeContinuationQuery = continuationParams.toString();
  const [config, setConfig] = useState<PptConfig>({ ...DEFAULT_CONFIG, requirement: "" });
  const [engines, setEngines] = useState<EngineInfo[]>([]);
  const [projectTemplates, setProjectTemplates] = useState<ProjectTemplateSummary[]>([]);

  const [materials, setMaterials] = useState<ContextItem[]>([]);
  const researchMode = config.mode === "research";
  const setResearchMode = (enabled: boolean) => {
    setConfig((current) => ({ ...current, mode: enabled ? "research" : "direct" }));
  };
  const [resumeLoading, setResumeLoading] = useState(Boolean(resumeId));

  const [phase, setPhase] = useState<Phase>("idle");
  const [stage, setStage] = useState<Stage>("clarify");
  const [questions, setQuestions] = useState<QuestionSpec[]>([]);
  const [clarifyBusy, setClarifyBusy] = useState(false);
  const [clarifyAnswerSummary, setClarifyAnswerSummary] = useState("");
  const [clarifyFormState, setClarifyFormState] = useState<ClarifyFormState | undefined>();
  const [workspaceMode, setWorkspaceMode] = useState<WorkspaceMode>("canvas");
  const [selectedDesignFileId, setSelectedDesignFileId] = useState<string>("questions");

  const [running, setRunning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [outline, setOutline] = useState<OutlinePage[]>([]);
  const [researchDoc, setResearchDoc] = useState("");
  const [researchProgress, setResearchProgress] = useState<ResearchProgress | undefined>();
  const [researchNote, setResearchNote] = useState("");
  const [slides, setSlides] = useState<UiSlide[]>([]);
  const slidesRef = useRef<UiSlide[]>(slides);
  slidesRef.current = slides;
  const conversationState = useChatConversations({
    initialMessages: [],
    initialTitle: t("chat.newConversationTitle"),
  });
  const chat = conversationState.messages;
  const setChat = conversationState.setMessages;
  const [queue, setQueue] = useState<QueuedChatRequest[]>([]);
  const queueRef = useRef<QueuedChatRequest[]>([]);
  const queueProjectRef = useRef<string | null>(null);
  const queueStartingRef = useRef<string | null>(null);
  const [queueDrainTick, setQueueDrainTick] = useState(0);
  const [editingQueuedRequestId, setEditingQueuedRequestId] = useState<string | null>(null);
  const [chatContext, setChatContext] = useState<SlideChatContext | null>(null);
  const [chatFocusKey, setChatFocusKey] = useState(0);
  const [focusSlideIndex, setFocusSlideIndex] = useState<number | null>(null);
  const [focusSlideKey, setFocusSlideKey] = useState(0);
  const [inspireOpen, setInspireOpen] = useState(false);
  const [inspireMsgId, setInspireMsgId] = useState<string | null>(null);
  const [inspireSelection, setInspireSelection] = useState<string | undefined>();
  const [inspirationSkipped, setInspirationSkipped] = useState(false);
  const [scenarioOpenRequestKey, setScenarioOpenRequestKey] = useState(0);
  const [versionHistoryOpen, setVersionHistoryOpen] = useState(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const checkpointTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latestCheckpointRef = useRef<{ patch: ProjectCheckpointPatch; signature: string } | null>(null);
  const lastCheckpointSignatureRef = useRef<string | null>(null);
  const creatingProjectRef = useRef(false);
  const markRunRef = useRef<{ id: string; startedAt: number; slideIndex: number } | null>(null);
  // Deep-research surfacing: the assistant turn that shows live web searches.
  const researchMsgIdRef = useRef<string | null>(null);
  const researchSearchCountRef = useRef(0);
  const researchSearchIdsRef = useRef(new Set<string>());

  const currentConversationQueue = queue.filter(
    (item) => item.conversationId === conversationState.activeConversationId,
  );

  useEffect(() => {
    fetch("/api/agents")
      .then((r) => r.json())
      .then((d) => {
        setEngines(d.engines ?? []);
      })
      .catch(() => setEngines([]));
  }, []);

  useEffect(() => {
    let disposed = false;
    const refresh = () => {
      void fetch("/api/templates", { cache: "no-store" })
        .then((response) => response.ok ? response.json() : Promise.reject(new Error("templates request failed")))
        .then((data) => {
          if (!disposed) setProjectTemplates(data.projectTemplates ?? []);
        })
        .catch(() => {
          if (!disposed) setProjectTemplates([]);
        });
    };
    refresh();
    window.addEventListener("codex-slides:templates-changed", refresh);
    return () => {
      disposed = true;
      window.removeEventListener("codex-slides:templates-changed", refresh);
    };
  }, []);

  const patchConfig = (patch: Partial<PptConfig>) => setConfig((c) => ({ ...c, ...patch }));
  const say = (m: ChatMsg) => setChat((c) => [...c, m]);

  function currentWorkflowStage() {
    if (
      stage === "outline"
      && running
      && config.mode === "research"
      && researchProgress?.status !== "complete"
      && researchProgress?.status !== "error"
      && outline.length === 0
    ) return "research" as const;
    if (stage === "outline" && running) return "outlining" as const;
    if (stage === "deck" && running) return "rendering" as const;
    return stage;
  }

  function persistCheckpoint(
    id: string | null = projectId,
    patch: ProjectCheckpointPatch = checkpointPatch(),
  ) {
    if (!id) return Promise.resolve();
    const signature = checkpointSignature(patch);
    if (signature === lastCheckpointSignatureRef.current) return Promise.resolve();
    return saveProjectCheckpoint(id, patch).then((saved) => {
      lastCheckpointSignatureRef.current = signature;
      if (latestCheckpointRef.current?.signature === signature) latestCheckpointRef.current = null;
      return saved;
    });
  }

  function checkpointPatch() {
    return {
      config,
      title: title || undefined,
      researchDoc,
      workflow: {
        stage: currentWorkflowStage(),
        researchMode,
        questions,
        clarifyForm: clarifyFormState,
        clarifyAnswerSummary,
        workspaceMode,
        selectedDesignFileId,
        inspirationSkipped,
        inspirationSelection: inspireSelection,
        queuedRequests: queue,
      },
    };
  }

  function leaveWorkspace() {
    void persistCheckpoint().catch(() => {});
    setPhase("idle");
    window.history.replaceState({}, "", "/");
  }

  useEffect(() => {
    if (!projectId) return;
    const patch = checkpointPatch();
    const signature = checkpointSignature(patch);
    if (signature === lastCheckpointSignatureRef.current) {
      latestCheckpointRef.current = null;
      return;
    }
    latestCheckpointRef.current = { patch, signature };
    cacheProjectCheckpoint(projectId, patch);
    if (checkpointTimer.current) clearTimeout(checkpointTimer.current);
    checkpointTimer.current = setTimeout(() => {
      checkpointTimer.current = null;
      void persistCheckpoint(projectId, patch).catch(() => {});
    }, 450);
    return () => {
      if (checkpointTimer.current) {
        clearTimeout(checkpointTimer.current);
        checkpointTimer.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    clarifyAnswerSummary,
    clarifyFormState,
    config,
    inspirationSkipped,
    inspireSelection,
    outline.length,
    projectId,
    queue,
    questions,
    researchDoc,
    researchProgress?.status,
    running,
    selectedDesignFileId,
    stage,
    title,
    workspaceMode,
  ]);

  useEffect(() => {
    if (!projectId) return;
    const flush = () => {
      const pending = latestCheckpointRef.current;
      if (pending && pending.signature !== lastCheckpointSignatureRef.current) {
        void persistCheckpoint(projectId, pending.patch).catch(() => {});
      }
    };
    const onVisibility = () => { if (document.visibilityState === "hidden") flush(); };
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", onVisibility);
      flush();
    };
  }, [projectId]);

  function updateChatMessage(id: string, update: (message: ChatMsg) => ChatMsg) {
    setChat((messages) => messages.map((message) => (message.id === id ? update(message) : message)));
  }

  function locateChatSlide(index: number) {
    setWorkspaceMode("canvas");
    setStage("deck");
    setFocusSlideIndex(index);
    setFocusSlideKey((key) => key + 1);
  }

  function openDesignFile(id: string) {
    setSelectedDesignFileId(id);
    setWorkspaceMode("files");
  }

  function onAddItems(next: ContextItem[]) {
    setMaterials(next);
    patchConfig({ materialIds: next.map((item) => item.id) });
  }
  function onRemoveMaterial(id: string) {
    const next = materials.filter((m) => m.id !== id);
    setMaterials(next);
    patchConfig({
      materialIds: next.map((m) => m.id),
      materialContexts: config.materialContexts?.filter((item) => item.id !== id),
    });
  }
  function selectScenario(scenario: PresentationScenario) {
    const current = config.requirement.trim();
    patchConfig({
      scenarioId: scenario.id,
      requirement: !current || isScenarioStarter(current)
        ? scenarioText(scenario.starter, locale)
        : config.requirement,
      pages: scenario.defaults.pages,
      aspect: scenario.defaults.aspect,
      style: scenario.defaults.style,
      mode: scenario.defaults.research ? "research" : "direct",
    });
  }
  function clearScenario() {
    patchConfig({ scenarioId: undefined });
  }
  function selectProjectTemplate(template: ProjectTemplateSummary) {
    patchConfig({
      projectTemplateId: template.id,
      template: template.baseTemplateId,
      style: template.style ?? "",
      designSystem: template.designSystem,
      aspect: template.aspect,
      resolution: template.resolution,
    });
  }
  function clearProjectTemplate() {
    patchConfig({
      projectTemplateId: undefined,
      designSystem: undefined,
      template: undefined,
      style: "",
    });
  }

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const requestedScenario = getScenario(params.get("scenario"));
    if (requestedScenario) selectScenario(requestedScenario);
    if (params.get("view") === "scenarios") setScenarioOpenRequestKey((key) => key + 1);
    // Browser deep links are consumed once on mount; subsequent UI state stays local.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!resumeId) return;
    let cancelled = false;
    void fetch(`/api/projects/${encodeURIComponent(resumeId)}`, { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json() as Promise<Project>;
      })
      .then((project) => {
        if (cancelled) return;
        const cached = readProjectCheckpointCache(project.id);
        const cachedAt = Number(cached?.workflow?.updatedAt) || 0;
        const serverAt = Number(project.workflow?.updatedAt) || 0;
        const useCached = Boolean(cached && cachedAt > serverAt);
        const checkpointConfig = useCached && cached?.config ? cached.config : project.config;
        const restoredWorkflow = {
          ...(project.workflow ?? { stage: project.status === "rendering" ? "rendering" as const : "outline" as const }),
          ...(useCached ? cached?.workflow : {}),
        };
        const restoreResearch = shouldResumeResearch(project, checkpointConfig, restoredWorkflow);
        const restoredConfig: PptConfig = {
          ...checkpointConfig,
          mode: restoreResearch ? "research" : "direct",
        };

        if (
          restoredWorkflow.stage !== "clarify"
          && restoredWorkflow.stage !== "research"
          && restoredWorkflow.stage !== "outlining"
        ) {
          window.location.replace(
            `/project/${encodeURIComponent(project.id)}${resumeContinuationQuery ? `?${resumeContinuationQuery}` : ""}`,
          );
          return;
        }

        const restoredQuestions = ensureRequiredOnboardQuestions(
          (restoredWorkflow.questions ?? []) as QuestionSpec[],
          locale,
        );
        setProjectId(project.id);
        setConfig(restoredConfig);
        setMaterials(checkpointMaterials(project));
        setTitle((useCached ? cached?.title : undefined) || project.title);
        setOutline(project.outline.map((page) => ({ title: page.title, points: [...page.points] })));
        setSlides(project.pages.map((page) => ({
          index: page.index,
          title: page.title,
          status: page.status,
          image: page.image,
          error: page.error,
          transition: page.transition,
          speakerNotes: page.speakerNotes,
        })));
        setQuestions(restoredQuestions);
        setClarifyFormState(restoredWorkflow.clarifyForm);
        setClarifyAnswerSummary(restoredWorkflow.clarifyAnswerSummary ?? "");
        setWorkspaceMode(restoredWorkflow.workspaceMode ?? "canvas");
        setSelectedDesignFileId(restoredWorkflow.selectedDesignFileId ?? "questions");
        setInspirationSkipped(Boolean(restoredWorkflow.inspirationSkipped));
        setInspireSelection(restoredWorkflow.inspirationSelection);
        const restoredQueue = (restoredWorkflow.queuedRequests ?? []) as QueuedChatRequest[];
        queueRef.current = restoredQueue;
        setQueue(restoredQueue);
        const restoredResearchDoc = (useCached ? cached?.researchDoc : undefined) ?? project.researchDoc ?? "";
        setResearchDoc(restoredResearchDoc);
        setResearchProgress(project.research ?? (restoredResearchDoc
          ? reduceResearchProgress(
              createResearchProgress(2, Date.parse(project.createdAt) || Date.now()),
              { type: "research", phase: "complete", markdown: restoredResearchDoc, round: 2, totalRounds: 2 },
              Date.parse(project.updatedAt) || Date.now(),
            )
          : undefined));
        setStage(restoredWorkflow.stage === "clarify" ? "clarify" : "outline");
        setRunning(false);
        setBusy(false);
        setClarifyBusy(false);
        setPhase("work");
        setResumeLoading(false);
        const restoredQuestionSubtitle = restoredWorkflow.clarifyAnswerSummary
          ? t("designFiles.questionsConfirmed", { count: restoredQuestions.length })
          : t("designFiles.questionsPending", { count: restoredQuestions.length });
        const restoreQuestionArtifact = (messages: ChatMsg[]) => messages.map((message) => (
          message.artifact?.kind === "questions"
            ? {
                ...message,
                content: t("designFiles.questionsPrepared", { count: restoredQuestions.length }),
                artifact: { ...message.artifact, subtitle: restoredQuestionSubtitle },
              }
            : message
        ));
        const restoredConversations = project.conversations?.map((conversation) => ({
          ...conversation,
          messages: restoreQuestionArtifact(conversation.messages as unknown as ChatMsg[]) as unknown as typeof conversation.messages,
        }));
        conversationState.restoreConversations(
          restoredConversations,
          project.activeConversationId,
          restoreQuestionArtifact((project.chat ?? []) as unknown as ChatMsg[]),
          project.title,
        );

        if (restoredWorkflow.stage === "research" || restoredWorkflow.stage === "outlining") {
          queueMicrotask(() => { void proceedToOutline(restoredConfig, project.id); });
        } else if (!restoredQuestions.length) {
          queueMicrotask(() => { void requestClarifyQuestions(restoredConfig, project.id); });
        }
      })
      .catch(() => {
        if (!cancelled) {
          setResumeLoading(false);
          window.history.replaceState({}, "", "/");
        }
      });
    return () => { cancelled = true; };
    // Restore once from the explicit deep link. Later navigation stays in-page.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resumeId, resumeContinuationQuery]);
  /** Reference images attached to a clarify question join the shared materials. */
  function attachClarifyImages(items: ContextItem[]) {
    onAddItems(mergeContextItems(materials, items));
  }

  // ---------------- step 1: clarify ----------------

  function submit(
    contextOptions: ContextOptionItem[],
    materialContexts: Array<{ id: string; name: string; role: string }> = [],
  ) {
    if (running || busy || clarifyBusy || creatingProjectRef.current) return;
    if (!config.requirement.trim() && !materials.length) return;
    const cfg = config.requirement.trim()
      ? { ...config, materialContexts }
      : { ...config, requirement: t("flow.attachedRequirement"), materialContexts };
    creatingProjectRef.current = true;
    void beginClarify(cfg, contextOptions);
  }

  async function beginClarify(cfg: PptConfig, contextOptions: ContextOptionItem[]) {
    setConfig(cfg);
    setPhase("work");
    setStage("clarify");
    setRunning(false);
    setBusy(false);
    setProjectId(null);
    setTitle("");
    setSlides([]);
    setOutline([]);
    setResearchDoc("");
    setResearchProgress(undefined);
    setResearchNote("");
    setInspirationSkipped(false);
    setInspireSelection(undefined);
    setClarifyAnswerSummary("");
    setClarifyFormState(undefined);
    setWorkspaceMode("canvas");
    setSelectedDesignFileId("questions");
    setChatContext(null);
    queueRef.current = [];
    queueProjectRef.current = null;
    queueStartingRef.current = null;
    setQueue([]);
    setEditingQueuedRequestId(null);
    setQuestions([]);

    conversationState.resetConversations([
      {
        role: "user",
        content: cfg.requirement,
        contextItems: materials,
        contextOptions,
      },
      { role: "assistant", content: t("flow.clarifyIntro") },
    ], cfg.requirement);

    try {
      setClarifyBusy(true);
      const checkpoint = await createProjectCheckpoint(cfg);
      setProjectId(checkpoint.id);
      setTitle(checkpoint.title);
      await requestClarifyQuestions(cfg, checkpoint.id);
    } catch (error: any) {
      say({ role: "assistant", content: `⚠ ${error?.message ?? error}` });
      setClarifyBusy(false);
    } finally {
      creatingProjectRef.current = false;
    }
  }

  async function requestClarifyQuestions(cfg: PptConfig, checkpointId: string) {
    setClarifyBusy(true);
    try {
      let received: QuestionSpec[] = [];
      await streamOnboard(
        { requirement: cfg.requirement, scenarioId: cfg.scenarioId, uiLocale: locale, projectId: checkpointId },
        (event) => {
          if (event.type === "question") {
            received = [...received];
            received[event.index] = event.question;
            setQuestions(received.filter(Boolean));
          } else if (event.type === "questions_done") {
            received = event.questions as QuestionSpec[];
            setQuestions(received);
            if (received.length) {
              say({
                role: "assistant",
                content: t("designFiles.questionsPrepared", { count: received.length }),
                artifact: {
                  id: "questions",
                  kind: "questions",
                  title: t("designFiles.questionsTitle"),
                  subtitle: t("designFiles.questionsPending", { count: received.length }),
                },
              });
            }
          } else if (event.type === "error") {
            say({ role: "assistant", content: `⚠ ${event.error}` });
          }
        },
      );
      if (received.length) {
        await saveProjectCheckpoint(checkpointId, {
          config: cfg,
          workflow: {
            stage: "clarify",
            researchMode: cfg.mode === "research",
            questions: received,
            workspaceMode: "canvas",
            selectedDesignFileId: "questions",
          },
        });
      } else {
        await proceedToOutline(cfg, checkpointId);
      }
    } catch {
      await proceedToOutline(cfg, checkpointId);
    } finally {
      setClarifyBusy(false);
    }
  }

  function applyClarify(patch: Partial<PptConfig>, suffix: string, summary: string) {
    const cfg: PptConfig = { ...config, ...patch, requirement: config.requirement + suffix };
    setClarifyAnswerSummary(summary.trim());
    setWorkspaceMode("canvas");
    if (summary.trim()) say({ role: "user", content: t("flow.confirmed", { summary }) });
    void proceedToOutline(cfg, projectId);
  }

  function skipClarify() {
    setClarifyAnswerSummary(t("designFiles.questionsSkipped"));
    setWorkspaceMode("canvas");
    say({ role: "user", content: t("flow.skipClarify") });
    void proceedToOutline(config, projectId);
  }

  // ---------------- step 2: search + outline ----------------

  async function proceedToOutline(base: PptConfig, checkpointId: string | null = projectId) {
    // The deep-research scenario (researchMode) always wins so the web search
    // actually runs; only fall back to the stored/base mode otherwise.
    const cfg: PptConfig = {
      ...base,
      mode: base.mode === "research" || researchMode ? "research" : "direct",
    };
    let durableProjectId = checkpointId;
    if (!durableProjectId) {
      const checkpoint = await createProjectCheckpoint(cfg);
      durableProjectId = checkpoint.id;
      setProjectId(checkpoint.id);
      setTitle(checkpoint.title);
    }
    setConfig(cfg);
    setStage("outline");
    setWorkspaceMode("canvas");
    setRunning(true);
    setSlides([]);
    setOutline([]);
    setResearchNote("");
    // Show the web-research process as its own visible, interleaved turn.
    researchMsgIdRef.current = null;
    researchSearchCountRef.current = 0;
    researchSearchIdsRef.current = new Set();
    const needsResearch = cfg.mode === "research" && !cfg.researchDoc?.trim();
    if (needsResearch) {
      setResearchProgress(createResearchProgress(2));
    } else if (cfg.mode !== "research") {
      setResearchProgress(undefined);
    }
    if (cfg.mode === "research") {
      const researchId = createAgentRunId("research");
      researchMsgIdRef.current = researchId;
      say({
        id: researchId,
        role: "assistant",
        content: "",
        blocks: [
          { id: "intro", type: "text", text: t("flow.researchIntro") },
          {
            id: "status",
            type: "tool",
            tool: {
              id: "status",
              name: "web_search",
              kind: "search",
              label: t("research.title"),
              detail: t("research.starting"),
              state: "running",
            },
          },
        ],
      });
    }
    try {
      await saveProjectCheckpoint(durableProjectId, {
        config: cfg,
        researchDoc,
        workflow: {
          stage: needsResearch ? "research" : "outlining",
          researchMode: cfg.mode === "research",
          questions,
          clarifyForm: clarifyFormState,
          clarifyAnswerSummary,
          workspaceMode: "canvas",
          selectedDesignFileId: "outline",
        },
      });
      await streamOutline(cfg, handleOutlineEvent, durableProjectId);
    } catch (e: any) {
      say({ role: "assistant", content: `⚠ ${e?.message ?? e}` });
    } finally {
      setRunning(false);
    }
  }

  function handleOutlineEvent(ev: ProgressEvent) {
    switch (ev.type) {
      case "research": {
        setResearchProgress((current) => reduceResearchProgress(current, ev));
        const researchId = researchMsgIdRef.current;
        const patchResearch = (updater: (blocks: MessageBlock[]) => MessageBlock[]) => {
          if (!researchId) return;
          updateChatMessage(researchId, (m) => ({ ...m, blocks: updater(m.blocks ?? []) }));
        };
        if (ev.phase === "starting") {
          setResearchNote(t("research.starting"));
        } else if (ev.phase === "planning") {
          setResearchNote(t("research.roundPlan", { round: ev.round ?? 1 }));
          patchResearch((blocks) => patchBlockTool(blocks, "status", {
            detail: t("research.stageRound", { round: ev.round ?? 1, total: ev.totalRounds ?? 2 }),
          }));
        } else if (ev.phase === "searching") {
          setResearchNote(t("flow.searching", { detail: ev.detail ?? "" }));
          if (ev.detail) {
            const searchKey = ev.callId || `${ev.round ?? 1}-${ev.detail}`;
            if (!researchSearchIdsRef.current.has(searchKey)) {
              researchSearchIdsRef.current.add(searchKey);
              researchSearchCountRef.current += 1;
            }
            const n = researchSearchCountRef.current;
            patchResearch((blocks) => patchBlockTool(
              upsertBlock(blocks, {
                id: `search-${searchKey}`,
                type: "tool",
                tool: { id: `search-${searchKey}`, name: "web_search", kind: "search", label: t("agent.search"), detail: ev.detail, state: ev.state ?? "running" },
              }),
              "status",
              { detail: t("research.searchCount", { count: n }) },
            ));
          }
        } else if (ev.phase === "writing") {
          setResearchNote(t("research.writingRound", { round: ev.round ?? 1 }));
          patchResearch((blocks) => patchBlockTool(blocks, "status", { detail: t("research.reportStreaming") }));
        } else if (ev.phase === "brief" && ev.markdown) {
          if (ev.final) setResearchNote(t("research.completeHelp"));
        } else if (ev.phase === "complete" && ev.markdown) {
          setResearchDoc(ev.markdown);
          setConfig((current) => ({ ...current, researchDoc: ev.markdown }));
          setResearchNote(t("research.outlineStarting"));
          patchResearch((blocks) => patchBlockTool(
            upsertBlock(blocks, { id: "report", type: "text", text: ev.markdown ?? "" }),
            "status",
            {
              state: "complete",
              label: t("research.complete"),
              detail: t("research.searchCount", { count: researchSearchCountRef.current }),
            },
          ));
        } else if (ev.phase === "error") {
          setResearchNote(ev.detail || t("research.failed"));
          patchResearch((blocks) => patchBlockTool(blocks, "status", {
            state: "error",
            label: t("research.failed"),
            detail: ev.detail,
          }));
        }
        break;
      }
      case "project":
        setProjectId(ev.id);
        break;
      case "outline_page":
        if (ev.index === 0) setTitle(ev.page.title);
        setOutline((current) => {
          const next = [...current];
          next[ev.index] = { title: ev.page.title, points: [...ev.page.points] };
          return next.filter(Boolean);
        });
        break;
      case "outline":
        setRunning(false);
        setTitle(ev.title);
        setOutline(ev.outline.map((o) => ({ title: o.title, points: [...o.points] })));
        setResearchNote("");
        if (researchMsgIdRef.current) {
          const settledCount = researchSearchCountRef.current;
          updateChatMessage(researchMsgIdRef.current, (m) => ({
            ...m,
            blocks: patchBlockTool(m.blocks ?? [], "status", {
              state: "complete",
              label: t("research.complete"),
              detail: t("research.searchCount", { count: settledCount }),
            }),
          }));
          researchMsgIdRef.current = null;
        }
        say({
          role: "assistant",
          content: t("flow.outlineReady", { count: ev.outline.length, title: ev.title }),
          doc: {
            title: ev.title,
            subtitle: t("flow.outlineDoc", { count: ev.outline.length }),
            pages: ev.outline.map((page) => ({ title: page.title, points: [...page.points] })),
            artifactId: "outline",
          },
        });
        break;
      case "error":
        say({ role: "assistant", content: `⚠ ${ev.error}` });
        break;
    }
  }

  // ---------------- step 3: edit outline ----------------

  function onOutlineChange(pages: OutlinePage[]) {
    setOutline(pages);
    setTitle(pages[0]?.title || "");
    if (!projectId) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      saveOutline(projectId, pages).catch(() => {});
    }, 700);
  }

  async function handleOutlineChat(request: ChatRequest) {
    if (!projectId) return;
    const designFiles = request.designFiles ?? [];
    say({
      role: "user",
      content: request.message,
      attachment: request.context,
      contextItems: request.attachments,
      designFiles,
    });
    setBusy(true);
    try {
      const { pages, reply } = await reviseOutlineChat(projectId, request.message, designFiles);
      setOutline(pages);
      setTitle(pages[0]?.title || title);
      say({ role: "assistant", content: reply || t("flow.outlineUpdated") });
    } catch (e: any) {
      say({ role: "assistant", content: `⚠ ${e?.message ?? e}` });
    } finally {
      setBusy(false);
    }
  }

  // ---------------- step 4: confirm → (inspire) → render ----------------

  /** Outline confirmed. If no style is chosen yet, detour to the inspiration
   *  step; otherwise render straight away. */
  async function confirmOutline() {
    if (!projectId || running || busy || !outline.length) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    try {
      await saveOutline(projectId, outline);
    } catch (e: any) {
      say({ role: "assistant", content: `⚠ ${e?.message ?? e}` });
      return;
    }
    say(outlineSnapshotMessage(title, outline));
    if (!config.template) {
      // Detour to the inspiration step: show the pending deck + an in-chat card
      // whose Browse button opens the style popup. Render waits for the pick/skip.
      setSlides(outline.map((o, i) => ({ index: i + 1, title: o.title, status: "pending" })));
      setStage("inspire");
      setInspireSelection("");
      void saveProjectCheckpoint(projectId, {
        config,
        title,
        researchDoc,
        workflow: {
          stage: "inspire",
          researchMode,
          questions,
          clarifyForm: clarifyFormState,
          clarifyAnswerSummary,
          workspaceMode: "canvas",
          selectedDesignFileId: "inspiration",
          inspirationSkipped: false,
        },
      }).catch(() => {});
      const matchQuery = [config.requirement, ...outline.map((o) => o.title)]
        .filter(Boolean)
        .join(" ");
      const msgId = createAgentRunId("inspire");
      setInspireMsgId(msgId);
      say({
        id: msgId,
        role: "assistant",
        content: t("flow.stylePrompt"),
        inspiration: {
          query: inspireQueryFor(config.requirement, title),
          coverIds: matchCommunityTemplates(matchQuery, 4).map((t) => t.id),
          total: COMMUNITY_TEMPLATES.length,
        },
      });
      return;
    }
    setInspirationSkipped(false);
    say(styleSnapshotMessage(config.template, config.requirement));
    renderNow();
  }

  /** Browse opens the popup; skip resolves the step with the default style. */
  function onInspire(action: "browse" | "skip") {
    if (action === "browse" && stage === "inspire") setWorkspaceMode("canvas");
    else if (action === "browse") setInspireOpen(true);
    else void handleInspireGenerate(undefined);
  }

  /** Apply an inspiration pick (or skip) then render. */
  async function handleInspireGenerate(templateId?: string) {
    if (!projectId || running || busy) return;
    const previousTemplate = config.template;
    const redrawExisting = Boolean(templateId) && stage === "deck" && slides.some((slide) => slide.status === "rendered");
    const versionGroupId = createAgentRunId("restyle-version");
    const versionPrompt = templateId
      ? t("flow.styleSelected", { name: getCommunityTemplate(templateId)?.name ?? templateId })
      : t("flow.styleSkipped");
    setInspireOpen(false);
    setInspireSelection("");
    if (templateId) {
      setInspirationSkipped(false);
      const tpl = getCommunityTemplate(templateId);
      patchConfig({ template: templateId });
      say({ role: "user", content: t("flow.styleSelected", { name: tpl?.name ?? templateId }) });
      try {
        await patchProjectStyle(projectId, { template: templateId }, {
          prompt: versionPrompt,
          groupId: versionGroupId,
        });
      } catch (e: any) {
        patchConfig({ template: previousTemplate });
        say({ role: "assistant", content: `⚠ ${t("flow.styleFailed", { error: e?.message ?? String(e) })}` });
        return;
      }
    } else {
      setInspirationSkipped(true);
      say({ role: "user", content: t("flow.styleSkipped") });
    }
    if (inspireMsgId) {
      updateChatMessage(inspireMsgId, (m) => ({
        ...m,
        inspiration: m.inspiration
          ? { ...m.inspiration, chosen: templateId, resolved: true }
          : undefined,
      }));
    }
    if (redrawExisting && templateId) {
      setBusy(true);
      say({ role: "assistant", content: t("restyle.started", { count: slides.length }) });
      for (const slide of slides) {
        setSlides((items) => items.map((item) => item.index === slide.index ? { ...item, status: "working" } : item));
        try {
          const image = await regenerateSlide(projectId, slide.index, undefined, undefined, {
            prompt: versionPrompt,
            groupId: versionGroupId,
          });
          setSlides((items) => items.map((item) => item.index === slide.index
            ? { ...item, status: "rendered", image, bust: Date.now() }
            : item));
        } catch (error: any) {
          setSlides((items) => items.map((item) => item.index === slide.index
            ? { ...item, status: "error", error: String(error?.message ?? error) }
            : item));
        }
      }
      say({ role: "assistant", content: t("restyle.done", { count: slides.length }) });
      setBusy(false);
      return;
    }
    renderNow();
  }

  // ---------------- step 5: render ----------------

  async function renderNow() {
    if (!projectId) return;
    setRunning(true);
    setWorkspaceMode("canvas");
    setSlides(outline.map((o, i) => ({ index: i + 1, title: o.title, status: "pending" })));
    setStage("deck");
    try {
      // Flush the latest conversation and workflow state before handing the
      // render to the server. From this point on the project-owned run, rather
      // than this React component or its fetch request, owns generation.
      await saveConversations(
        projectId,
        conversationState.conversations,
        conversationState.activeConversationId,
      );
      await saveProjectCheckpoint(projectId, {
        config,
        title,
        researchDoc,
        workflow: {
          stage: "deck",
          researchMode,
          questions,
          clarifyForm: clarifyFormState,
          clarifyAnswerSummary,
          workspaceMode: "canvas",
          selectedDesignFileId,
          inspirationSkipped,
          inspirationSelection: inspireSelection,
          queuedRequests: queue,
        },
      });
      await startDetachedProjectRun(projectId, {
        kind: "render",
        conversationId: conversationState.activeConversationId,
        locale,
      });
      // The project workspace polls the persisted run. Navigating there also
      // proves the task is no longer coupled to the home page lifecycle.
      window.location.assign(`/project/${encodeURIComponent(projectId)}`);
    } catch (e: any) {
      say({ role: "assistant", content: `⚠ ${e?.message ?? e}` });
    } finally {
      setRunning(false);
    }
  }

  function handleEvent(ev: ProgressEvent) {
    switch (ev.type) {
      case "project":
        setProjectId(ev.id);
        break;
      case "page_start":
        setSlides((s) => s.map((x) => (x.index === ev.index ? { ...x, status: "working" } : x)));
        break;
      case "page_rendered":
        setSlides((s) =>
          s.map((x) =>
            x.index === ev.index ? { ...x, status: "rendered", image: ev.image, bust: Date.now() } : x,
          ),
        );
        break;
      case "page_error":
        setSlides((s) =>
          s.map((x) => (x.index === ev.index ? { ...x, status: "error", error: ev.error } : x)),
        );
        break;
      case "done":
        setRunning(false);
        break;
      case "error":
        say({ role: "assistant", content: `⚠ ${ev.error}` });
        break;
    }
  }

  // ---------------- step 6: follow-up edits (deck stage) ----------------

  async function handleChat(request: ChatRequest) {
    if (!projectId) return;
    setBusy(true);
    try {
      await runChatTurn(request, {
        projectId,
        locale,
        t,
        say,
        update: updateChatMessage,
        getSlides: () => slidesRef.current,
        setSlides,
        appendTodos: conversationState.appendTodos,
        patchTodo: conversationState.patchTodo,
        supportsDesignFiles: true,
      });
    } catch {
      /* runChatTurn writes the failure into the transcript */
    } finally {
      setBusy(false);
    }
  }

  function commitQueue(next: QueuedChatRequest[]) {
    queueRef.current = next;
    setQueue(next);
    if (projectId) saveQueuedChatRequests(projectId, next);
  }

  function addQueuedRequest(conversationId: string, request: ChatRequest) {
    commitQueue([...queueRef.current, createQueuedChatRequest(conversationId, request)]);
  }

  function removeQueuedRequest(id: string) {
    commitQueue(queueRef.current.filter((item) => item.id !== id));
    if (editingQueuedRequestId === id) setEditingQueuedRequestId(null);
  }

  function updateQueuedRequest(id: string, request: ChatRequest) {
    commitQueue(queueRef.current.map((item) => (
      item.id === id ? updateQueuedChatRequest(item, request) : item
    )));
  }

  function reorderQueuedRequests(orderedIds: string[]) {
    commitQueue(reorderConversationQueue(
      queueRef.current,
      conversationState.activeConversationId,
      orderedIds,
    ));
  }

  function prioritizeQueuedRequest(id: string) {
    commitQueue(prioritizeQueuedChatRequest(queueRef.current, id));
    setQueueDrainTick((tick) => tick + 1);
  }

  /** Route a chat turn to the right handler for the current stage. */
  function runRequest(request: ChatRequest): Promise<void> {
    if (stage === "outline") return handleOutlineChat(request);
    return handleChat(request);
  }

  /** Queue follow-ups typed while work is in flight; run immediately when idle. */
  function enqueueOrRun(request: ChatRequest) {
    const conversationId = conversationState.activeConversationId;
    const hasQueuedTurn = queueRef.current.some((item) => item.conversationId === conversationId);
    if (running || busy || clarifyBusy || !projectId || hasQueuedTurn || queueStartingRef.current) {
      addQueuedRequest(conversationId, request);
      return;
    }
    void runRequest(snapshotChatRequest(request));
  }

  useEffect(() => {
    if (!projectId) return;
    if (queueRef.current.length > 0 && queueProjectRef.current == null) {
      queueProjectRef.current = projectId;
      saveQueuedChatRequests(projectId, queueRef.current);
      setQueue((current) => [...current]);
      return;
    }
    const restored = loadQueuedChatRequests(projectId);
    queueProjectRef.current = projectId;
    queueRef.current = restored;
    setQueue(restored);
    queueStartingRef.current = null;
    setEditingQueuedRequestId(null);
  }, [projectId]);

  // Drain exactly one queued follow-up whenever the active conversation goes
  // idle. Editing the head pauses the drain until the user saves or cancels.
  useEffect(() => {
    if (running || busy || clarifyBusy || !projectId) {
      queueStartingRef.current = null;
      return;
    }
    if (queueStartingRef.current) return;
    const next = queueRef.current.find(
      (item) => item.conversationId === conversationState.activeConversationId,
    );
    if (!next || editingQueuedRequestId === next.id) return;
    queueStartingRef.current = next.id;
    commitQueue(queueRef.current.filter((item) => item.id !== next.id));
    void runRequest(snapshotChatRequest(next));
    queueMicrotask(() => {
      if (queueStartingRef.current !== next.id) return;
      queueStartingRef.current = null;
      setQueueDrainTick((tick) => tick + 1);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    running,
    busy,
    clarifyBusy,
    projectId,
    queue,
    queueDrainTick,
    conversationState.activeConversationId,
    editingQueuedRequestId,
  ]);

  // Persist all conversations once the project exists, including the active selection.
  useEffect(() => {
    if (!projectId || !conversationState.conversations.length) return;
    const t = setTimeout(() => saveConversations(
      projectId,
      conversationState.conversations,
      conversationState.activeConversationId,
    ), 600);
    return () => clearTimeout(t);
  }, [conversationState.activeConversationId, conversationState.conversations, projectId]);

  function askAboutSlide(slide: UiSlide) {
    if (!projectId) return;
    setChatContext({
      slideIndex: slide.index,
      title: slide.title || t("chat.slide", { index: slide.index }),
      imageUrl: fileUrl(projectId, slide.image, slide.bust),
    });
    setChatFocusKey((key) => key + 1);
  }

  function mirrorMarkToChat(event: MarkAgentEvent) {
    if (!projectId) return;
    if (event.type === "request") {
      say({
        role: "user",
        content: event.note || t("agent.markRequest", { index: event.slide.index }),
        attachment: {
          slideIndex: event.slide.index,
          title: `${event.slide.title} · ${t("agent.visualMark")}`,
          imageUrl: fileUrl(projectId, event.markedImage),
        },
      });
      const runId = createAgentRunId("visual-mark");
      markRunRef.current = { id: runId, startedAt: Date.now(), slideIndex: event.slide.index };
      say({
        id: runId,
        role: "assistant",
        content: "",
        process: {
          state: "running",
          title: t("agent.editingSlide", { index: event.slide.index }),
          notes: [
            t("agent.markNoteOne"),
            t("agent.markNoteTwo"),
          ],
          tools: [{
            id: "mark-edit",
            name: "mark_edit_page",
            label: t("agent.applyVisual"),
            detail: t("agent.processMark", { index: event.slide.index }),
            state: "running",
          }],
        },
      });
    } else if (event.type === "complete") {
      const run = markRunRef.current;
      if (!run) return;
      updateChatMessage(run.id, (current) => ({
        ...current,
        content: t("agent.markApplied", { index: event.slide.index }),
        ran: elapsedRunLabel(run.startedAt, locale),
        attachment: {
          slideIndex: event.slide.index,
          title: `${event.slide.title} · ${t("agent.updated")}`,
          imageUrl: fileUrl(projectId, event.image, Date.now()),
        },
        process: {
          ...patchAgentTool(current.process!, "mark-edit", { state: "complete", detail: t("agent.updatedSaved") }),
          state: "complete",
          title: t("agent.updatedSlide", { index: event.slide.index }),
        },
      }));
      markRunRef.current = null;
    } else if (event.type === "error") {
      const run = markRunRef.current;
      if (!run) return;
      updateChatMessage(run.id, (current) => ({
        ...current,
        content: `⚠ ${event.error}`,
        ran: elapsedRunLabel(run.startedAt, locale),
        process: {
          ...patchAgentTool(current.process!, "mark-edit", { state: "error", detail: event.error }),
          state: "error",
          title: t("agent.notUpdated", { index: event.slide.index }),
        },
      }));
      markRunRef.current = null;
    }
  }

  const designFiles = useMemo<DesignFile[]>(() => {
    const files: DesignFile[] = [];
    if (questions.length) {
      files.push({
        id: "questions",
        kind: "questions",
        title: t("designFiles.questionsTitle"),
        subtitle: clarifyAnswerSummary
          ? t("designFiles.questionsConfirmed", { count: questions.length })
          : t("designFiles.questionsPending", { count: questions.length }),
        questions,
        answerSummary: clarifyAnswerSummary || undefined,
      });
    }
    if (outline.length) {
      files.push({
        id: "outline",
        kind: "outline",
        title: title || t("designFiles.outlineTitle"),
        subtitle: stage === "outline"
          ? t("designFiles.outlineEditing", { count: outline.length })
          : t("designFiles.outlineConfirmed", { count: outline.length }),
        pages: outline.map((page) => ({ title: page.title, points: [...page.points] })),
      });
    }
    if (config.mode === "research" && (researchProgress || researchDoc)) {
      const report = researchProgress?.markdown || researchDoc;
      const reportStatus = researchProgress?.status ?? "complete";
      files.push({
        id: "research",
        kind: "research",
        title: t("designFiles.researchTitle"),
        subtitle: reportStatus === "running"
          ? t("designFiles.researchRunning", { count: researchProgress?.sources.length ?? 0 })
          : reportStatus === "error"
            ? t("designFiles.researchError")
            : t("designFiles.researchComplete", { count: researchProgress?.sources.length ?? 0 }),
        markdown: report,
        status: reportStatus,
      });
    }
    if (stage === "inspire" || config.template || inspirationSkipped) {
      const matchQuery = [config.requirement, ...outline.map((page) => page.title)].filter(Boolean).join(" ");
      files.push({
        id: "inspiration",
        kind: "inspiration",
        title: t("designFiles.inspirationTitle"),
        subtitle: inspirationSkipped
          ? t("designFiles.inspirationSkipped")
          : config.template
            ? t("designFiles.inspirationSelected")
            : t("designFiles.inspirationPending"),
        selectedTemplateId: config.template ?? inspireSelection,
        candidateTemplateIds: matchCommunityTemplates(matchQuery, 4).map((template) => template.id),
        skipped: inspirationSkipped,
      });
    }
    return files;
  }, [clarifyAnswerSummary, config.mode, config.requirement, config.template, inspirationSkipped, inspireSelection, outline, questions, researchDoc, researchProgress, stage, t, title]);

  // ---------------- WORK VIEW (clarify → outline → deck) ----------------
  if (resumeLoading && phase === "idle") {
    return <ProjectLoadingShell />;
  }

  if (phase === "work") {
    const status: GenStatus | null =
      stage === "deck"
        ? deriveStatus(slides, { streaming: running, editing: busy })
        : stage === "outline" && running
          ? { phase: "outlining", total: 0, done: 0, note: researchNote || undefined }
          : null;
    const renderedSlides = slides.filter((slide) => slide.status === "rendered").length;
    const templateLabel = config.template
      ? getCommunityTemplate(config.template)?.name ?? config.template
      : undefined;
    const workflow = buildWorkflowProgress({
      stage,
      clarifyBusy,
      questionCount: questions.length,
      outlineCount: outline.length,
      researchEnabled: researchMode || config.mode === "research",
      researchStatus: researchProgress?.status ?? (researchDoc ? "complete" : undefined),
      researchPhase: researchProgress?.phase,
      researchRound: researchProgress?.round,
      researchTotalRounds: researchProgress?.totalRounds,
      researchSearchCount: researchProgress?.searchCount,
      researchSourceCount: researchProgress?.sources.length,
      templateLabel,
      inspirationSkipped,
      running: stage === "deck" && running,
      rendered: renderedSlides,
      total: slides.length || outline.length,
      renderDetail: status?.phase === "rendering"
        ? status.note
          || (status.current
            ? t("status.renderingNamed", { index: status.current, title: status.currentTitle ? ` · ${status.currentTitle}` : "" })
            : t("status.renderingCount", { done: status.done, total: status.total }))
        : undefined,
      locale,
    });
    const workspaceTabs = (
      <WorkspaceModeTabs mode={workspaceMode} fileCount={designFiles.length} onChange={setWorkspaceMode} />
    );
    const versionHistoryAction = projectId && stage === "deck" ? (
      <div className="deck-header-extras">
        <button
          type="button"
          className={`iconbtn version-history-trigger${versionHistoryOpen ? " active" : ""}`}
          disabled={running || busy || clarifyBusy}
          onClick={() => setVersionHistoryOpen(true)}
          title={t("versions.title")}
        >
          <ClockCounterClockwise size={18} weight="regular" aria-hidden="true" />
          <span className="stage-action-label">{t("versions.entry")}</span>
        </button>
      </div>
    ) : undefined;
    const placeholder =
      stage === "clarify"
        ? t("flow.placeholderClarify")
        : stage === "outline"
          ? t("flow.placeholderOutline")
          : stage === "inspire"
            ? t("flow.placeholderInspire")
            : t("flow.placeholderDeck");
    return (
      <div className="ws project-ws">
        <ChatColumn
          projectId={projectId}
          workspaceTitle={title || undefined}
          onHome={leaveWorkspace}
          messages={chat}
          busy={running || busy || clarifyBusy}
          onSend={enqueueOrRun}
          status={status}
          queued={currentConversationQueue}
          editingQueuedId={editingQueuedRequestId}
          onEditingQueuedChange={setEditingQueuedRequestId}
          onUpdateQueued={updateQueuedRequest}
          onRemoveQueued={removeQueuedRequest}
          onReorderQueued={reorderQueuedRequests}
          onPrioritizeQueued={prioritizeQueuedRequest}
          context={chatContext}
          onClearContext={() => setChatContext(null)}
          focusKey={chatFocusKey}
          onSelectSlide={locateChatSlide}
          onInspire={onInspire}
          onOpenDesignFile={openDesignFile}
          workflow={workflow}
          todos={conversationState.todos}
          conversations={projectId ? conversationState.summaries : undefined}
          activeConversationId={projectId ? conversationState.activeConversationId : undefined}
          onSelectConversation={projectId ? (id) => {
            if (running || busy || clarifyBusy) return;
            setEditingQueuedRequestId(null);
            setChatContext(null);
            conversationState.selectConversation(id);
          } : undefined}
          onCreateConversation={projectId ? () => {
            if (running || busy || clarifyBusy) return;
            setEditingQueuedRequestId(null);
            setChatContext(null);
            conversationState.createConversation();
          } : undefined}
          onRenameConversation={projectId ? conversationState.renameConversation : undefined}
          onDeleteConversation={projectId ? (id) => {
            conversationState.deleteConversation(id);
            commitQueue(queueRef.current.filter((item) => item.conversationId !== id));
            setEditingQueuedRequestId(null);
          } : undefined}
          conversationManagementDisabled={running || busy || clarifyBusy}
          placeholder={placeholder}
        />
        {workspaceMode === "files" ? (
          <DesignFilesPanel
            files={designFiles}
            selectedId={selectedDesignFileId}
            onSelect={setSelectedDesignFileId}
            headerPrefix={workspaceTabs}
          />
        ) : stage === "clarify" ? (
          <section className="stage clarify-stage">
            <div className="stage-head">
              {workspaceTabs}
              <span className="title">{t("onboard.stageTitle")}</span>
              <span className="count">{t("onboard.step")}</span>
            </div>
            <div className="clarify-pane">
              <p className="clarify-topic">{config.requirement}</p>
              {!questions.length ? (
                <div className="clarify-loading">
                  <div className="clarify-loading-head">
                    <span className="spinner sm" />
                    <span>{t("onboard.preparing")}</span>
                  </div>
                  <div className="clarify-skeleton">
                    {[0, 1, 2, 3].map((k) => (
                      <div className="clarify-skeleton-q" key={k}>
                        <span className="skeleton skel-line" style={{ width: `${44 + k * 12}%` }} />
                        <div className="clarify-skeleton-opts">
                          <span className="skeleton" />
                          <span className="skeleton" />
                          <span className="skeleton" />
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ) : (
                <OnboardForm
                  questions={questions}
                  busy={clarifyBusy}
                  initialState={clarifyFormState}
                  availableImages={materials.filter((item) => item.kind === "image")}
                  onStateChange={setClarifyFormState}
                  onCancel={skipClarify}
                  onComplete={applyClarify}
                  onAttachImages={attachClarifyImages}
                  onRemoveImage={onRemoveMaterial}
                  submitLabel={t("onboard.confirmOutline")}
                  skipLabel={t("onboard.skip")}
                />
              )}
            </div>
          </section>
        ) : stage === "outline" && config.mode === "research" && researchProgress && outline.length === 0 ? (
          <ResearchStage
            progress={researchProgress}
            headerPrefix={workspaceTabs}
            outlineStarting={researchProgress.status !== "running" && running}
          />
        ) : stage === "outline" ? (
          <OutlineBoard
            title={title}
            showTitle={false}
            aspect={config.aspect}
            outline={outline}
            onChange={onOutlineChange}
            onConfirm={confirmOutline}
            busy={running}
            streaming={running}
            researchDoc={researchDoc}
            headerPrefix={workspaceTabs}
          />
        ) : stage === "inspire" ? (
          <InspirationStage
            requirement={config.requirement}
            outlineTitles={outline.map((page) => page.title).filter(Boolean)}
            selected={inspireSelection}
            busy={running || busy}
            headerPrefix={workspaceTabs}
            onSelect={(templateId) => setInspireSelection(templateId ?? "")}
            onSkip={() => void handleInspireGenerate(undefined)}
            onConfirm={(templateId) => void handleInspireGenerate(templateId)}
          />
        ) : (
          <SlideStage
            projectId={projectId}
            aspect={config.aspect}
            title={title}
            showTitle={false}
            slides={slides}
            onSlides={(u) => setSlides(u)}
            busy={busy}
            setBusy={setBusy}
            streaming={running}
            headerPrefix={workspaceTabs}
            onAskSlide={askAboutSlide}
            onMarkAgentEvent={mirrorMarkToChat}
            focusSlideIndex={focusSlideIndex}
            focusSlideKey={focusSlideKey}
            headerExtra={versionHistoryAction}
          />
        )}
        {inspireOpen && (
          <InspireDialog
            requirement={config.requirement}
            outlineTitles={outline.map((o) => o.title).filter(Boolean)}
            selected={config.template}
            intent={stage === "deck" ? "apply" : "generate"}
            onClose={() => setInspireOpen(false)}
            onSkip={stage === "deck" ? undefined : () => handleInspireGenerate(undefined)}
            onSubmit={(id) => handleInspireGenerate(id)}
          />
        )}
        {versionHistoryOpen && projectId ? (
          <DeckVersionDialog
            projectId={projectId}
            onClose={() => setVersionHistoryOpen(false)}
            onRestored={(restored) => {
              setConfig(restored.config);
              setTitle(restored.title);
              setOutline(restored.outline.map((page) => ({ title: page.title, points: [...page.points] })));
              setSlides(restored.pages.map((page) => ({
                index: page.index,
                title: page.title,
                status: page.status,
                image: page.image,
                error: page.error,
                bust: page.imageUpdatedAt,
                transition: page.transition,
                speakerNotes: page.speakerNotes,
              })));
              setMaterials(checkpointMaterials(restored));
              setResearchDoc(restored.researchDoc ?? "");
              setResearchProgress(restored.research);
              setStage("deck");
            }}
          />
        ) : null}
      </div>
    );
  }

  // ---------------- LAUNCHER ----------------
  const communityStyle = getCommunityTemplate(config.template);
  const curatedStyle = communityStyle ? undefined : getTemplate(config.template);
  const selectedStyle = communityStyle
    ? { id: communityStyle.id, name: communityStyle.name, cover: communityStyle.cover, sub: communityStyle.group }
    : curatedStyle
      ? { id: curatedStyle.id, name: curatedStyle.name, palette: curatedStyle.palette, sub: t("template.preset") }
      : null;
  const selectedScenario = getScenario(config.scenarioId);
  const selectedProjectTemplate = projectTemplates.find((template) => template.id === config.projectTemplateId) ?? null;
  return (
    <>
      <TopBar />
      <main className="launch">
        <div className="launch-hero">
          <div className="plan-pill">
            <span>{t("home.badge")}</span>
            <span className="divider" />
            <span style={{ color: "var(--muted)" }}>{t("home.tagline")}</span>
          </div>
          <h1>{t("home.title")}</h1>
          <ScenarioPicker
            selected={config.scenarioId}
            onSelect={selectScenario}
            openRequestKey={scenarioOpenRequestKey}
          />
          <Composer
            config={config}
            setConfig={patchConfig}
            engines={engines}
            running={running || clarifyBusy}
            researchMode={researchMode}
            setResearchMode={setResearchMode}
            materials={materials}
            onAddItems={onAddItems}
            onRemoveMaterial={onRemoveMaterial}
            styleTemplate={selectedStyle}
            onClearStyle={() => patchConfig({ template: undefined })}
            projectTemplates={projectTemplates}
            projectTemplate={selectedProjectTemplate}
            onSelectProjectTemplate={selectProjectTemplate}
            onClearProjectTemplate={clearProjectTemplate}
            scenario={selectedScenario}
            onClearScenario={clearScenario}
            onSubmit={submit}
          />
          <CodexTutorial />
        </div>
        <Community
          selected={config.template}
          requirement={config.requirement}
          onPick={(id) => patchConfig({ template: config.template === id ? undefined : id })}
        />
        <HomeLibrary
          templates={projectTemplates}
          selectedTemplateId={config.projectTemplateId}
          onUseTemplate={selectProjectTemplate}
          onDeleteTemplate={(id) => {
            setProjectTemplates((current) => current.filter((template) => template.id !== id));
            if (config.projectTemplateId === id) clearProjectTemplate();
          }}
        />
      </main>
    </>
  );
}
