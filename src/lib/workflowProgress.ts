import { translate, type UiLocale } from "@/i18n/messages";

export type WorkflowStepState = "complete" | "active" | "pending" | "skipped" | "error";

export interface WorkflowProgress {
  steps: {
    id: "clarify" | "research" | "outline" | "inspire" | "render";
    label: string;
    detail: string;
    state: WorkflowStepState;
  }[];
  progress?: { done: number; total: number };
}

export type PresentationWorkflowStage = "clarify" | "outline" | "inspire" | "deck";

export function buildWorkflowProgress({
  stage,
  clarifyBusy = false,
  questionCount = 0,
  outlineCount = 0,
  researchEnabled = false,
  researchStatus,
  researchPhase,
  researchRound = 0,
  researchTotalRounds = 2,
  researchSearchCount = 0,
  researchSourceCount = 0,
  templateLabel,
  inspirationSkipped = false,
  running = false,
  rendered = 0,
  total = 0,
  renderDetail,
  locale = "ja",
}: {
  stage: PresentationWorkflowStage;
  clarifyBusy?: boolean;
  questionCount?: number;
  outlineCount?: number;
  researchEnabled?: boolean;
  researchStatus?: "running" | "complete" | "error";
  researchPhase?: "starting" | "planning" | "searching" | "writing" | "complete" | "error";
  researchRound?: number;
  researchTotalRounds?: number;
  researchSearchCount?: number;
  researchSourceCount?: number;
  templateLabel?: string;
  inspirationSkipped?: boolean;
  running?: boolean;
  rendered?: number;
  total?: number;
  renderDetail?: string;
  locale?: UiLocale;
}): WorkflowProgress {
  const afterClarify = stage !== "clarify";
  const afterOutline = stage === "inspire" || stage === "deck";
  const afterInspiration = stage === "deck";
  const researchSettled = researchStatus === "complete" || researchStatus === "error" || afterOutline;
  const researchBlocking = researchEnabled && afterClarify && !researchSettled;

  const clarifyState: WorkflowStepState = afterClarify ? "complete" : "active";
  const outlineState: WorkflowStepState = stage === "clarify"
    ? "pending"
    : researchBlocking
      ? "pending"
    : stage === "outline"
      ? "active"
      : "complete";
  const inspirationState: WorkflowStepState = !afterOutline
    ? "pending"
    : stage === "inspire"
      ? "active"
      : inspirationSkipped
        ? "skipped"
        : "complete";
  const renderState: WorkflowStepState = !afterInspiration
    ? "pending"
    : running
      ? "active"
      : rendered > 0 || total === 0
        ? "complete"
        : "pending";

  const steps: WorkflowProgress["steps"] = [
      {
        id: "clarify",
        label: translate(locale, "workflow.clarify"),
        state: clarifyState,
        detail: clarifyState === "active"
          ? clarifyBusy
            ? translate(locale, "workflow.preparing")
            : questionCount
              ? translate(locale, "workflow.questionsPending", { count: questionCount })
              : translate(locale, "workflow.waitingBrief")
          : questionCount
            ? translate(locale, "workflow.questionsConfirmed", { count: questionCount })
            : translate(locale, "workflow.briefConfirmed"),
      },
      ...(researchEnabled ? [{
        id: "research" as const,
        label: translate(locale, "workflow.research"),
        state: (stage === "clarify"
          ? "pending"
          : researchStatus === "error"
            ? "error"
            : researchSettled
              ? "complete"
              : "active") as WorkflowStepState,
        detail: stage === "clarify"
          ? translate(locale, "workflow.researchAfterBrief")
          : researchStatus === "error"
            ? translate(locale, "workflow.researchFailed")
            : researchSettled
              ? translate(locale, "workflow.researchComplete", {
                  searches: researchSearchCount,
                  sources: researchSourceCount,
                })
              : researchPhase === "writing"
                ? translate(locale, "workflow.researchWriting", {
                    round: researchRound || 1,
                    total: researchTotalRounds,
                  })
                : translate(locale, "workflow.researching", {
                    round: researchRound || 1,
                    total: researchTotalRounds,
                    searches: researchSearchCount,
                  }),
      }] : []),
      {
        id: "outline",
        label: translate(locale, "workflow.outline"),
        state: outlineState,
        detail: outlineState === "pending"
          ? translate(locale, researchBlocking ? "workflow.afterResearch" : "workflow.afterBrief")
          : outlineState === "active"
            ? running && !outlineCount
              ? translate(locale, "workflow.generatingOutline")
              : translate(locale, "workflow.outlineEditable", { count: outlineCount || "—" })
            : translate(locale, "workflow.outlineConfirmed", { count: outlineCount }),
      },
      {
        id: "inspire",
        label: translate(locale, "workflow.inspiration"),
        state: inspirationState,
        detail: inspirationState === "pending"
          ? translate(locale, "workflow.afterOutline")
          : inspirationState === "active"
            ? translate(locale, "workflow.pickInspiration")
            : inspirationState === "skipped"
              ? translate(locale, "workflow.inspirationSkipped")
              : translate(locale, "workflow.inspirationSelected", {
                  name: templateLabel || translate(locale, "workflow.selectedFallback"),
                }),
      },
      {
        id: "render",
        label: translate(locale, "workflow.render"),
        state: renderState,
        detail: renderState === "pending"
          ? translate(locale, "workflow.afterInspiration")
          : renderState === "active"
            ? renderDetail || translate(locale, "workflow.rendering", { done: rendered, total })
            : translate(locale, "workflow.rendered", { done: rendered || total, total: total || rendered }),
      },
    ];

  return {
    steps,
    progress: stage === "deck" && total > 0 ? { done: rendered, total } : undefined,
  };
}
