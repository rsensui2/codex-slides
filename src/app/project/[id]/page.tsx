import { notFound, redirect } from "next/navigation";
import DeckView from "@/components/DeckView";
import { loadProject } from "@/lib/store";

export const dynamic = "force-dynamic";

/** Project workspace: chat feed + live slide preview + filmstrip (per-page editing). */
export default async function ProjectPage({
  params: paramsPromise,
  searchParams: searchParamsPromise,
}: {
  params: Promise<{ id: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await paramsPromise;
  const searchParams = await searchParamsPromise;
  // Next's page params can retain percent-encoding for non-ASCII slugs even
  // though route-handler params are decoded. Normalize here so decks created
  // with Chinese/Japanese/etc. titles can be reopened from their preview URL.
  let projectId = params.id;
  try {
    projectId = decodeURIComponent(projectId);
  } catch {
    // A malformed URL is not a valid project id; loadProject will return null.
  }
  const project = loadProject(projectId);
  if (!project) notFound();
  if (
    project.workflow?.stage === "clarify"
    || project.workflow?.stage === "research"
    || project.workflow?.stage === "outlining"
  ) {
    const query = new URLSearchParams();
    query.set("resume", projectId);
    for (const [key, value] of Object.entries(searchParams ?? {})) {
      if (key === "resume") continue;
      if (Array.isArray(value)) value.forEach((item) => query.append(key, item));
      else if (typeof value === "string") query.set(key, value);
    }
    redirect(`/?${query.toString()}`);
  }
  return <DeckView key={project.id} projectId={projectId} initialProject={project} />;
}
