// Shared domain types for codex-slides.

export type Aspect = "16:9" | "4:3" | "1:1" | "9:16" | "3:4";
export type Language = "zh" | "en" | "ja" | "auto";
export type Resolution = "1K" | "2K" | "4K";
export type SlideTransition = "none" | "fade" | "push" | "wipe" | "zoom" | "flip";
export type DesignDensity = "compact" | "balanced" | "spacious";

/** Project-wide brand and design rules that every agent turn should inherit. */
export interface DeckDesignSystem {
  version: 1;
  brand: {
    name: string;
    tagline: string;
    voice: string;
    logoUsage: string;
    /** Persistent project material ids used as logo / product / visual references. */
    assetMaterialIds: string[];
  };
  style: {
    direction: string;
    keywords: string;
    imageTreatment: string;
  };
  colors: {
    primary: string;
    primaryTint: string;
    accent: string;
    accentTint: string;
    ink: string;
    surface: string;
    background: string;
    backgroundWarm: string;
  };
  typography: {
    headingFont: string;
    bodyFont: string;
    monoFont: string;
    headingWeight: number;
    bodyWeight: number;
    scale: string;
  };
  effects: {
    shadow: string;
    border: string;
    texture: string;
  };
  spacing: {
    density: DesignDensity;
    baseUnit: number;
    sectionGap: number;
  };
  radius: {
    card: number;
    control: number;
    pill: number;
  };
}

/** Which engine drives the TEXT stages (outline + per-page copy). */
export type Engine = "codex" | "codex-cli" | "claude-cli" | "gemini-cli";

export interface PptConfig {
  requirement: string;
  aspect: Aspect;
  pages: number; // desired page count (a hint to the model)
  language: Language;
  style?: string; // free-text style / tone, e.g. "swiss international, indigo accent"
  resolution: Resolution;
  engine: Engine;
  template?: string; // DeckTemplate id (see lib/templates.ts); overrides/augments style
  /** User-created project template. Its brand system, visual references, and
   * base style are copied into the new project without copying source content. */
  projectTemplateId?: string;
  materialIds?: string[]; // staged context-item ids (images and supported documents)
  /** Semantic roles assigned by scenario file slots (source deck, dataset, brand guide, etc.). */
  materialContexts?: Array<{ id: string; name: string; role: string }>;
  mode?: "direct" | "research"; // deep-research mode seeds the outline from a research doc
  researchDoc?: string; // markdown research brief used as outline context (research mode)
  fast?: boolean; // fast mode: render every page in parallel (rate-limit-queued) instead of one-by-one
  /** Home workflow preset. Its stable id restores the model-facing scenario contract. */
  scenarioId?: string;
  /** Always-on project context for generation, chat planning, and later edits. */
  designSystem?: DeckDesignSystem;
}

export interface MaterialRecord {
  id: string;
  name: string;
  file: string; // file name within the project's materials/ dir
  /** Project-relative Design Files path (for example uploaded/source.html).
   * Local agents receive the corresponding absolute path instead of a staging
   * or opaque materials path, so they can inspect the source on demand. */
  designFilePath?: string;
  kind?: "image" | "file";
  mimeType?: string;
  size?: number;
  role?: "logo" | "reference" | "content" | "slide" | "template";
}

/** A reusable visual/brand snapshot saved from an existing presentation. */
export interface ProjectTemplateSummary {
  id: string;
  name: string;
  description: string;
  sourceProjectId: string;
  sourceProjectTitle: string;
  createdAt: string;
  updatedAt: string;
  aspect: Aspect;
  resolution: Resolution;
  style?: string;
  baseTemplateId?: string;
  designSystem?: DeckDesignSystem;
  coverUrl?: string;
  referenceCount: number;
  brandAssetCount: number;
}

export interface ProjectFileRecord {
  path: string;
  /** Absolute local path used by an agent after the user explicitly references this file. */
  absolutePath: string;
  name: string;
  kind: "document" | "image" | "data" | "code" | "other";
  source: "generated" | "uploaded";
  size: number;
  updatedAt: string;
  editable: boolean;
}

/** A Design Files item explicitly attached to one chat turn via @ mention. */
export interface DesignFileReference {
  /** Absolute local path. This is the durable, agent-readable reference value. */
  path: string;
  /** Project-relative path used to reopen the item in the Design Files workspace. */
  relativePath: string;
  name: string;
  kind?: ProjectFileRecord["kind"];
}

export const DEFAULT_CONFIG: PptConfig = {
  requirement: "",
  aspect: "16:9",
  pages: 6,
  language: "ja",
  style: "",
  resolution: "2K",
  engine: "codex",
};

export interface OutlinePage {
  title: string;
  points: string[];
}

/** One web source discovered while deep research is running. The URL is the
 * durable identity; title/snippet can be enriched later by URL citations as
 * the report streams. */
export interface ResearchSource {
  id: string;
  url: string;
  title: string;
  snippet?: string;
  round?: number;
}

export interface ResearchActivity {
  id: string;
  kind: "round" | "search" | "writing";
  round: number;
  detail?: string;
  state: "pending" | "running" | "complete" | "error";
  ts: number;
}

/** Durable mirror of the right-side deep-research stage. It intentionally
 * stores the process as well as the final markdown so a reload does not turn a
 * long search into an unexplained blank screen. */
export interface ResearchProgress {
  status: "running" | "complete" | "error";
  phase: "starting" | "planning" | "searching" | "writing" | "complete" | "error";
  round: number;
  totalRounds: number;
  searchCount: number;
  activities: ResearchActivity[];
  sources: ResearchSource[];
  markdown: string;
  draftRound?: number;
  error?: string;
  startedAt: number;
  updatedAt: number;
  completedAt?: number;
}

export type SlideStatus = "pending" | "described" | "rendered" | "error";

export interface SlidePage {
  index: number; // 1-based
  title: string;
  points: string[];
  description?: string; // "页面文字" body used to compose the image
  imagePrompt?: string;
  image?: string; // file name relative to the project dir, e.g. "03.png"
  /** Changes only when this slide's image bytes change. Metadata saves must not
   * invalidate every image in the deck. */
  imageUpdatedAt?: number;
  status: SlideStatus;
  error?: string;
  /** Presentation-mode transition used when this page becomes active. */
  transition?: SlideTransition;
  /** Presenter-only talking points. These stay off-canvas, appear in speaker
   * view, and are embedded as native PowerPoint speaker notes on export. */
  speakerNotes?: string;
}

/**
 * Lifecycle of a deck in the staged flow:
 *  - draft:     outline written, no slides rendered yet (awaiting confirm/edit)
 *  - rendering: per-slide image generation in progress
 *  - ready:     generation finished (has rendered slides)
 * Missing/undefined ⇒ treat as "ready" (back-compat for pre-staged project.json).
 */
export type ProjectStatus = "draft" | "rendering" | "ready";

/** Durable position inside the create flow. A project exists from the first
 * clarification screen onward, so leaving or reloading never discards work. */
export type ProjectWorkflowStage =
  | "clarify"
  | "research"
  | "outlining"
  | "outline"
  | "inspire"
  | "rendering"
  | "deck";

export interface ProjectWorkflowQuestion {
  id: string;
  question: string;
  type: "single" | "multi" | "text" | "number";
  options?: Array<{ value: string; label: string }>;
  placeholder?: string;
  recommended?: string;
  field?: "pages" | "aspect" | "resolution" | "language" | "style" | "category" | null;
}

export interface ClarifyFormState {
  answers: Record<string, string | string[]>;
  custom: Record<string, string>;
  images?: Record<string, string[]>;
}

export interface ProjectWorkflowState {
  stage: ProjectWorkflowStage;
  updatedAt?: number;
  /** Explicit mirror of the launcher's deep-research toggle. Keeping this in
   * the workflow prevents a clarify-stage reload from silently dropping the
   * research step before the outline request is started. */
  researchMode?: boolean;
  questions?: ProjectWorkflowQuestion[];
  clarifyForm?: ClarifyFormState;
  clarifyAnswerSummary?: string;
  workspaceMode?: "canvas" | "files";
  selectedDesignFileId?: string;
  inspirationSkipped?: boolean;
  /** Style highlighted on the full-page inspiration step but not confirmed. */
  inspirationSelection?: string;
  queuedRequests?: Array<{
    id?: string;
    conversationId?: string;
    createdAt?: number;
    updatedAt?: number;
    message: string;
    context?: { slideIndex: number; title: string; imageUrl?: string };
    attachments?: Array<{
      id: string;
      name: string;
      url: string;
      kind: "image" | "file";
      mimeType: string;
      size: number;
    }>;
    designFiles?: DesignFileReference[];
  }>;
}

/** A durable project-owned task. Unlike component-local `busy` state, this
 * record survives route changes and lets the server resume work after a reload. */
export type ProjectRunKind = "chat" | "outline" | "render" | "mark";

export interface ProjectRunChatRequest {
  message: string;
  context?: { slideIndex: number; title: string; imageUrl?: string };
  attachments?: Array<{
    id: string;
    name: string;
    url: string;
    kind: "image" | "file";
    mimeType: string;
    size: number;
  }>;
  designFiles?: DesignFileReference[];
}

export interface ProjectRunInput {
  kind: ProjectRunKind;
  conversationId?: string;
  locale?: string;
  request?: ProjectRunChatRequest;
  mark?: {
    index: number;
    source: string;
    note: string;
    title?: string;
  };
}

export interface ProjectRunState {
  id: string;
  kind: ProjectRunKind;
  status: "running" | "stopping";
  conversationId?: string;
  label: string;
  detail?: string;
  targetSlide?: number;
  progress?: { current: number; total: number };
  startedAt: number;
  updatedAt: number;
  /** Persisted so a local server reload can resume the same operation. */
  input: ProjectRunInput;
}

/** Terminal project-owned task retained for MCP/CLI status checks after the
 * active worker has completed, failed, or been cancelled. */
export interface ProjectRunRecord extends Omit<ProjectRunState, "status"> {
  status: "complete" | "error" | "cancelled";
  completedAt: number;
  error?: string;
}

/** A non-file choice attached to a user turn, displayed like other context. */
export interface ContextOptionItem {
  id: string;
  kind: "research" | "style" | "template" | "setting" | "speed" | "scenario";
  label: string;
  value?: string;
}

/** JSON-safe mirror of an AgentToolCall (see lib/agentActivity.ts). */
export interface StoredAgentTool {
  id: string;
  name: string;
  label: string;
  detail?: string;
  kind?: "tool" | "read" | "write" | "edit" | "bash" | "todo" | "files" | "search";
  path?: string;
  relativePath?: string;
  command?: string;
  output?: string;
  todos?: Array<{ id: string; content: string; status: "pending" | "in_progress" | "complete" | "error" }>;
  files?: DesignFileReference[];
  state: "pending" | "running" | "complete" | "error";
}

/** One task in the project-wide checklist that persists across chat turns. */
export interface StoredGlobalTodo {
  id: string;
  content: string;
  status: "pending" | "in_progress" | "complete" | "error";
  group?: string;
  turnId?: string;
  ts?: number;
}

/** A persisted conversation turn (mirrors the client ChatMsg, JSON-safe). */
export interface StoredChatMessage {
  id?: string;
  role: "user" | "assistant";
  content: string;
  ran?: string;
  doc?: {
    title: string;
    subtitle: string;
    icon?: string;
    pages?: { title: string; points: string[] }[];
    artifactId?: string;
  };
  artifact?: {
    id: string;
    kind: "questions" | "outline" | "inspiration";
    title: string;
    subtitle: string;
  };
  attachment?: { slideIndex: number; title: string; imageUrl?: string };
  contextItems?: { id: string; name: string; url?: string; kind?: string }[];
  designFiles?: DesignFileReference[];
  contextOptions?: ContextOptionItem[];
  suggestions?: string[];
  process?: {
    state: "running" | "complete" | "error";
    title: string;
    notes?: string[];
    tools: StoredAgentTool[];
  };
  /** Interleaved transcript: ordered Markdown text + tool blocks. Newer chat
   *  turns use this instead of `content` + `process` (kept for legacy turns). */
  blocks?: Array<
    | { id: string; type: "text"; text: string }
    | { id: string; type: "tool"; tool: StoredAgentTool }
  >;
  inspiration?: {
    query: string;
    coverIds: string[];
    total: number;
    chosen?: string;
    resolved?: boolean;
  };
  /** Provider-reported usage when available. Older/local turns can omit it; the
   *  client then labels its visible-output count as an estimate. */
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    costUsd?: number;
    model?: string;
    estimated?: boolean;
  };
  ts?: number;
}

/** One independently managed conversation inside a presentation project. */
export interface StoredConversation {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: StoredChatMessage[];
  /** Project-wide checklist for this conversation, shown pinned above the chat. */
  todos?: StoredGlobalTodo[];
}

export interface Project {
  id: string;
  createdAt: string;
  updatedAt: string;
  config: PptConfig;
  agent: string; // orchestrating agent actually used
  title: string;
  outline: OutlinePage[];
  pages: SlidePage[];
  materials?: MaterialRecord[];
  researchDoc?: string;
  /** Live and historical deep-research process, including search calls and sources. */
  research?: ResearchProgress;
  status?: ProjectStatus;
  /** Persisted create-flow checkpoint used for full-chain resume. */
  workflow?: ProjectWorkflowState;
  /** Full conversation history so reopening a project restores the dialogue. */
  chat?: StoredChatMessage[];
  /** Multi-session history. `chat` remains as a backwards-compatible mirror of
   *  the active conversation for older project files and API clients. */
  conversations?: StoredConversation[];
  activeConversationId?: string;
  /** The only project mutation currently executing in the server background. */
  activeRun?: ProjectRunState;
  /** Recent terminal jobs. This makes run ids durable across navigation,
   * MCP reconnects, and local server restarts. */
  runHistory?: ProjectRunRecord[];
}

/** Immutable deck snapshots shown in version management. Restoring a snapshot
 * creates a new current version instead of rewriting the selected history item. */
export type DeckVersionSource = "ai" | "manual" | "restore";
export type DeckVersionPromptSource = "message" | "project" | "manual" | "restore";

export interface DeckVersionSummary {
  id: string;
  version: number;
  label: string;
  createdAt: number;
  source: DeckVersionSource;
  prompt: string | null;
  promptSource?: DeckVersionPromptSource;
  restoreFromVersionId?: string;
  current: boolean;
  title: string;
  aspect: Aspect;
  slideCount: number;
  renderedCount: number;
  coverImage?: string;
}

export interface DeckVersionDetail {
  version: DeckVersionSummary;
  /** Read-only project state captured with this version. Chat/run state is not
   * rolled back, but page order, images, transitions, notes, and config are. */
  project: Project;
}

/** Optional provenance supplied by a multi-step edit. Calls sharing groupId
 * update one in-progress version instead of creating a version per slide. */
export interface DeckVersionCaptureInput {
  prompt?: string | null;
  promptSource?: DeckVersionPromptSource;
  source?: DeckVersionSource;
  label?: string;
  groupId?: string;
}

export interface DetectedAgent {
  id: string;
  label: string;
  vendor: string;
  bin: string;
  available: boolean;
  path?: string;
  /** true = usable as the text engine in this app */
  supported: boolean;
}

// ---- SSE progress events streamed by /api/generate, /api/outline, /api/.../render ----
export interface ResearchProgressEvent {
  type: "research";
  phase: "starting" | "planning" | "searching" | "source" | "writing" | "delta" | "brief" | "complete" | "error";
  round?: number;
  totalRounds?: number;
  detail?: string;
  callId?: string;
  state?: "running" | "complete";
  delta?: string;
  markdown?: string;
  final?: boolean;
  source?: ResearchSource;
}

export type ProgressEvent =
  | { type: "agent"; agent: string; engine: Engine }
  | { type: "question"; question: ProjectWorkflowQuestion; index: number }
  | { type: "questions_done"; questions: ProjectWorkflowQuestion[] }
  | { type: "project"; id: string }
  | ResearchProgressEvent
  | { type: "outline"; outline: OutlinePage[]; title: string }
  | { type: "outline_page"; page: OutlinePage; index: number }
  | { type: "page_start"; index: number; total: number; title: string }
  | { type: "page_described"; index: number }
  | { type: "page_rendered"; index: number; image: string }
  | { type: "page_error"; index: number; error: string }
  // A page's copy/image stage failed and is being re-attempted inside the same
  // render pass. `attempt` is the try that just failed (1-based); the page is
  // NOT yet in `error` — it only lands there after all attempts are spent.
  | { type: "page_retry"; index: number; attempt: number; maxAttempts: number; stage: "copy" | "image"; error: string }
  // The post-render verification sweep that guarantees every page ends rendered.
  // `pending` = pages still missing an image; `rendered` = pages already done.
  | { type: "verify"; phase: "start" | "round" | "done"; round: number; total: number; pending: number; rendered: number }
  | { type: "log"; message: string }
  | { type: "done"; id: string }
  | { type: "error"; error: string };
