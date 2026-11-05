// One "Extract facts" run after its preconditions are met: plan, ask the
// model, ground the answer, optionally verify it with Jev, then review and
// apply. Pure: every step is injected, so the lifecycle (an unload or cancel
// at any point stops the run, and a stopped run writes nothing) is testable
// without Obsidian.
import type { ApplyOutcome } from "./api";
import type { AbortToken } from "./ingest-transport";
import type { Judged, JevNote, Verification } from "./jev-ingest";
import type { IngestAcceptResult, IngestPlanResult, ModelRequest, ModelResponse, PatchProposal } from "./protocol";

export interface IngestRunDeps {
  plan(path: string): Promise<IngestPlanResult>;
  /** Ask the model about every chunk; stops between chunks once `abort` is set. */
  callModel(request: ModelRequest, abort: AbortToken): Promise<ModelResponse[]>;
  accept(path: string, request: ModelRequest, responses: ModelResponse[]): Promise<IngestAcceptResult>;
  /** The Jev verifier, or `null` while the option is off. */
  judge: ((accept: (r: ModelResponse[]) => Promise<IngestAcceptResult>, request: ModelRequest, responses: ModelResponse[], plain: IngestAcceptResult) => Promise<Judged>) | null;
  /** The review dialog; resolves true only when the user presses Apply. */
  review(result: IngestAcceptResult, notes: readonly JevNote[], verification: Verification): Promise<boolean>;
  applyPatch(proposal: PatchProposal, confirm: (p: PatchProposal) => Promise<boolean>): Promise<ApplyOutcome>;
}

/** `aborted`: stopped before anything was written; `reviewed`: shown, nothing to write; otherwise the apply outcome. */
export type IngestRunOutcome = { status: "aborted" } | { status: "reviewed" } | ApplyOutcome;

/** Run extraction for `path`. Checks `run.aborted` after every step that awaits, and once more after the user applies. */
export async function runIngest(path: string, deps: IngestRunDeps, run: AbortToken): Promise<IngestRunOutcome> {
  const aborted: IngestRunOutcome = { status: "aborted" };
  const { request } = await deps.plan(path);
  if (run.aborted) return aborted;
  const responses = await deps.callModel(request, run);
  if (run.aborted) return aborted;
  const plain = await deps.accept(path, request, responses);
  if (run.aborted) return aborted;
  // Jev option: off by default. With it off the flow is the pre-option flow.
  const judged: Pick<Judged, "result" | "notes" | "verification"> = deps.judge
    ? await deps.judge((r) => deps.accept(path, request, r), request, responses, plain)
    : { result: plain, notes: [], verification: { state: "off" } };
  if (run.aborted) return aborted;
  const { result, notes, verification } = judged;
  if (!result.preview) {
    await deps.review(result, notes, verification);
    return { status: "reviewed" };
  }
  // An unload while the dialog was open must not let a late Apply write.
  return deps.applyPatch(result.preview, async () => (await deps.review(result, notes, verification)) && !run.aborted);
}
