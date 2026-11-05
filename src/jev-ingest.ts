// OB-01-S1-01: the Jev semantic verifier for assisted-ingest suggestions.
//
// Runs AFTER the engine has grounded the model's answer. It asks one Noul per
// accepted fact: does the located quote itself state it? A fact Jev doubts is
// annotated in the review dialog; only if the user set a withhold threshold
// is a fact the verifier rates at or below it also dropped, and then the
// engine's own `ingest_accept` is run again on the surviving proposals, so
// grounding, kind and conflict checks, the digest guard and the reviewed
// diff all still produce the patch. Pure: the engine call is injected.
//
// When the verifier cannot answer, the outcome depends on that same
// threshold. At 0 (advisory, the default) the facts are kept and the review
// dialog says plainly that Jev could not verify them. Above 0 the user asked
// for a filter, so the run fails closed: every fact Jev did not verify is
// withheld as `not_verified` and no patch is offered for it.
import { OntomarkError } from "./client";
import type { CandidateAssertion, IngestAcceptResult, ModelRequest, ModelResponse, Withheld } from "./protocol";
import { DOUBT_BELOW, verifyFacts } from "./jev";
import type { JevConfig, JevDeps } from "./jev";

/** What the review dialog shows next to an accepted fact. */
export interface JevNote {
  key: string;
  written: string;
  /** Jev's probability that the quote supports the fact. */
  p: number;
}

/**
 * What the verifier established, shown at the top of the review dialog.
 * - `off`: the Jev option is off; the dialog shows nothing about it.
 * - `verified`: Jev rated every fact; any it rejected are withheld as `judged_unsupported`.
 * - `not_verified`: Jev did not rate them (`reason` says why). `withheld` is
 *   true when the threshold made the run fail closed and the unverified facts
 *   were withheld; false when they were kept, unverified (advisory mode).
 */
export type Verification =
  | { state: "off" }
  | { state: "verified" }
  | { state: "not_verified"; reason: string; withheld: boolean };

export interface Judged {
  result: IngestAcceptResult;
  notes: JevNote[];
  /** `applied`, `nothing-to-judge`, or why the verifier did not verify. */
  outcome: string;
  verification: Verification;
}

export type AcceptFn = (responses: ModelResponse[]) => Promise<IngestAcceptResult>;

const same = (a: CandidateAssertion, key: string, written: string): boolean => a.key === key && a.written === written;

const withheldAs = (f: CandidateAssertion, reason: string): Withheld => ({
  chunk: f.evidence[0]?.chunk ?? 0,
  key: f.key,
  value: f.written,
  reason: { reason },
  evidence: f.evidence[0] ?? null,
});

/**
 * Run the engine again without the proposals that produced `drop`, so the
 * patch and every downstream check come from the engine, and report each
 * dropped fact as withheld with its reason. `null` when the re-run would write
 * something the plain run did not (it must be monotone).
 */
async function withhold(
  accept: AcceptFn,
  responses: ModelResponse[],
  plain: IngestAcceptResult,
  drop: { fact: CandidateAssertion; reason: string }[],
): Promise<IngestAcceptResult | null> {
  // Which proposals produced the dropped facts? Ask the engine about each on its own.
  const dropped = new Set<string>();
  for (const r of responses) {
    for (let ai = 0; ai < r.assertions.length; ai++) {
      const one = await accept([{ chunk: r.chunk, assertions: [r.assertions[ai]] }]);
      const fact = one.candidates.accepted[0];
      if (fact && drop.some((x) => same(x.fact, fact.key, fact.written))) dropped.add(`${r.chunk}:${ai}`);
    }
  }
  const kept: ModelResponse[] = responses.map((r) => ({
    chunk: r.chunk,
    assertions: r.assertions.filter((_, ai) => !dropped.has(`${r.chunk}:${ai}`)),
  }));
  const after = await accept(kept);
  // Monotone: the re-run may only write facts the plain run wrote.
  if (!after.candidates.accepted.every((a) => plain.candidates.accepted.some((b) => same(b, a.key, a.written)))) return null;
  // ... and none of the facts it was asked to drop.
  if (after.candidates.accepted.some((a) => drop.some((x) => same(x.fact, a.key, a.written)))) return null;
  const withheld: Withheld[] = [...after.candidates.withheld, ...drop.map((x) => withheldAs(x.fact, x.reason))];
  return { ...after, candidates: { ...after.candidates, withheld } };
}

/**
 * The last resort of a run that must fail closed but could not get a filtered
 * patch from the engine: nothing is offered for writing, and every accepted
 * fact is listed as withheld (`judged_unsupported` where Jev rejected it,
 * otherwise `not_verified`).
 */
function nothingWritten(plain: IngestAcceptResult, rejected: CandidateAssertion[]): IngestAcceptResult {
  const withheld: Withheld[] = [
    ...plain.candidates.withheld,
    ...plain.candidates.accepted.map((f) =>
      withheldAs(f, rejected.some((r) => same(r, f.key, f.written)) ? "judged_unsupported" : "not_verified"),
    ),
  ];
  return { ...plain, preview: null, candidates: { ...plain.candidates, patch: null, accepted: [], withheld } };
}

/**
 * Verify the accepted facts of `plain` (the result of `accept(responses)`).
 * Never throws except `disposed` (the engine went away; the run must stop).
 * See the header for what happens when the verifier cannot answer.
 */
export async function judgeIngest(
  accept: AcceptFn,
  request: ModelRequest,
  responses: ModelResponse[],
  plain: IngestAcceptResult,
  cfg: JevConfig,
  deps: JevDeps,
): Promise<Judged> {
  // Off: the pre-option flow, untouched (the caller normally does not get here).
  if (!cfg.enabled) return { result: plain, notes: [], outcome: "flag-off", verification: { state: "off" } };
  const failClosed = cfg.withholdAtOrBelow > 0;
  const facts = plain.candidates.accepted.filter((a) => a.evidence.length > 0);
  // Facts with no quote cannot be put to the verifier.
  const unquoted = plain.candidates.accepted.filter((a) => a.evidence.length === 0);

  /** The verifier did not verify the facts in `unverified` (and rejected those in `rejected`). */
  const notVerified = async (reason: string, unverified: CandidateAssertion[], rejected: CandidateAssertion[] = []): Promise<Judged> => {
    if (!failClosed) {
      return { result: plain, notes: [], outcome: reason, verification: { state: "not_verified", reason, withheld: false } };
    }
    const verification: Verification = { state: "not_verified", reason, withheld: true };
    const drop = [
      ...rejected.map((fact) => ({ fact, reason: "judged_unsupported" })),
      ...unverified.map((fact) => ({ fact, reason: "not_verified" })),
    ];
    let result: IngestAcceptResult | null = null;
    try {
      result = await withhold(accept, responses, plain, drop);
    } catch (err) {
      if (err instanceof OntomarkError && err.code === "disposed") throw err;
    }
    return { result: result ?? nothingWritten(plain, rejected), notes: [], outcome: reason, verification };
  };

  if (facts.length === 0 && unquoted.length === 0) {
    return { result: plain, notes: [], outcome: "nothing-to-judge", verification: { state: "verified" } };
  }
  if (facts.length === 0) return notVerified("no-quote", unquoted);

  let ps: number[];
  try {
    const verdict = await verifyFacts(
      cfg,
      deps,
      request.note.label,
      facts.map((f) => ({ key: f.key, predicate: f.predicate, written: f.written, quote: f.evidence[0].quote })),
    );
    if (!verdict.ok) return notVerified(verdict.reason, plain.candidates.accepted);
    ps = verdict.value;
  } catch (err) {
    if (err instanceof OntomarkError && err.code === "disposed") throw err;
    return notVerified("error", plain.candidates.accepted);
  }

  const notes: JevNote[] = [];
  const rejected: CandidateAssertion[] = [];
  facts.forEach((f, i) => {
    const p = ps[i];
    if (p < DOUBT_BELOW) notes.push({ key: f.key, written: f.written, p });
    // 0 means "never withhold": the default accepts nothing automatically.
    if (failClosed && p <= cfg.withholdAtOrBelow) rejected.push(f);
  });
  // Quoted facts were all rated; a fact without a quote never is.
  if (unquoted.length > 0) {
    const judged = await notVerified("no-quote", unquoted, rejected);
    return { ...judged, notes: notes.filter((n) => !rejected.some((f) => same(f, n.key, n.written))) };
  }
  if (rejected.length === 0) return { result: plain, notes, outcome: "applied", verification: { state: "verified" } };

  let after: IngestAcceptResult | null = null;
  let why = "not-monotone";
  try {
    after = await withhold(
      accept,
      responses,
      plain,
      rejected.map((fact) => ({ fact, reason: "judged_unsupported" })),
    );
  } catch (err) {
    if (err instanceof OntomarkError && err.code === "disposed") throw err;
    why = "error";
  }
  if (after === null) {
    // Jev rejected facts but the engine could not produce a patch without them:
    // never fall back to the plain patch, which would write what Jev rejected.
    return { result: nothingWritten(plain, rejected), notes: [], outcome: why, verification: { state: "not_verified", reason: why, withheld: true } };
  }
  return {
    result: after,
    notes: notes.filter((n) => !rejected.some((f) => same(f, n.key, n.written))),
    outcome: "applied",
    verification: { state: "verified" },
  };
}
