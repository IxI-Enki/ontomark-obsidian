// Rendering of a SPARQL result into an Obsidian element, shared by the query
// view and the in-note `ontomark-sparql` block so both show the same table.
import type { Status } from "../api";
import type { Classification, DatasetSelection, QueryResult, WireTerm } from "../protocol";
import { compactIri } from "./entity-view";

/** Cell text for a term, with the full IRI or datatype as the hover title. */
export function termText(t: WireTerm): { text: string; title?: string } {
  if (t.type === "iri") return { text: compactIri(t.value), title: t.value };
  if (t.type === "bnode") return { text: `_:${t.value}` };
  return { text: t.value, title: t.lang ? `@${t.lang}` : t.datatype };
}

/** What a result was computed over, shown above it so a reader knows how far to trust an empty answer. */
export interface QueryEnvelope {
  dataset: DatasetSelection;
  /** Generation the result belongs to (the guard discards any other). */
  generation: number;
  /** The classification known for the index, or `null` when none is known. */
  classification: Classification | null;
}

/** The envelope for a result just returned by `api` over `dataset`. */
export function queryEnvelope(api: { status(): Status }, dataset: DatasetSelection): QueryEnvelope {
  const s = api.status();
  return { dataset, generation: s.generation, classification: s.classification };
}

/** Why reasoning behind `c` may have missed inferences; empty when it is complete. */
export function incompleteness(c: Classification | null): string[] {
  if (c === null) return ["no classification is known for this index"];
  const why: string[] = [];
  if (!c.reasoner.el_complete) why.push("the reasoner is not OWL 2 EL complete");
  if (c.unsupported.length > 0) why.push(`${c.unsupported.length} axiom(s) not used`);
  if (c.policy === "relevant") why.push("the complete policy ran out of budget");
  if (!c.complete && why.length === 0) why.push("classification did not complete");
  return why;
}

function renderEnvelope(out: HTMLElement, env: QueryEnvelope): void {
  const inferred = env.dataset !== "asserted";
  const why = inferred ? incompleteness(env.classification) : [];
  const reasoning = !inferred ? "asserted triples only" : why.length === 0 ? "reasoning complete" : "reasoning incomplete";
  out.createDiv({
    text: `Dataset ${env.dataset} · generation ${env.generation} · ${reasoning}`,
    cls: "ontomark-query-status",
    attr: { "data-ontomark": "query-status" },
  });
  if (why.length > 0) {
    out.createDiv({
      text: `Inferred triples may be missing (${why.join("; ")}): a row that is absent here is not evidence that a statement is false.`,
      cls: "ontomark-warning",
      attr: { "data-ontomark": "query-incomplete" },
    });
  }
}

/**
 * Render `r` into `out` (emptied first): the envelope when given, then a
 * boolean for ASK, otherwise a table, a row count and a truncation notice.
 */
export function renderQueryResult(out: HTMLElement, r: QueryResult, env?: QueryEnvelope): void {
  out.empty();
  if (env) renderEnvelope(out, env);
  if (r.form === "ask") {
    out.createDiv({ text: r.boolean ? "true" : "false", cls: "ontomark-ask" });
    if (!r.boolean) {
      out.createDiv({
        text: "No match: the pattern did not match the data. That does not show the statement is false.",
        cls: "ontomark-help",
        attr: { "data-ontomark": "ask-note" },
      });
    }
    return;
  }
  const table = out.createEl("table", { cls: "ontomark-table" });
  const head = table.createEl("tr");
  const cell = (row: { createEl: HTMLElement["createEl"] }, t: WireTerm | undefined): void => {
    if (!t) {
      row.createEl("td", { text: "" });
      return;
    }
    const { text, title } = termText(t);
    row.createEl("td", { text, attr: title ? { title } : {} });
  };
  if (r.form === "select") {
    for (const v of r.variables) head.createEl("th", { text: v });
    for (const binding of r.rows) {
      const tr = table.createEl("tr");
      for (const v of r.variables) cell(tr, binding[v]);
    }
  } else {
    for (const h of ["subject", "predicate", "object"]) head.createEl("th", { text: h });
    for (const [s, p, o] of r.triples) {
      const tr = table.createEl("tr");
      cell(tr, s);
      cell(tr, p);
      cell(tr, o);
    }
  }
  const count = r.form === "select" ? r.rows.length : r.triples.length;
  out.createDiv({ text: `${count} row${count === 1 ? "" : "s"}`, cls: "ontomark-count" });
  if (r.truncated) {
    out.createDiv({ text: "Truncated: more results exist than the row limit allows.", cls: "ontomark-warning" });
  }
}
