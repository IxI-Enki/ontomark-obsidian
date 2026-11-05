// The query surfaces at their render boundary: in-note SPARQL blocks, the
// query view, the shared result renderer, and the ingest review dialog. The
// Obsidian API is the offline e2e's filesystem-backed shim (its fake DOM is
// enough here); the engine is the real one wherever the guard's channel
// semantics matter.
import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => createRequire(import.meta.url)("./e2e/obsidian-shim.cjs"));

import { OntomarkApi } from "../src/api";
import type { ChangeEvent, Status, VaultPort } from "../src/api";
import { OntomarkClient, OntomarkError } from "../src/client";
import type { Classification, IngestAcceptResult, QueryResult } from "../src/protocol";
import { SparqlBlock } from "../src/sparql-block";
import { QueryView } from "../src/views/query-view";
import { renderQueryResult } from "../src/views/query-render";
import { confirmIngest } from "../src/views/ingest-modal";
import type { Verification } from "../src/jev-ingest";
import type OntomarkPlugin from "../src/main";
import { InProcWorker, readVault, tick } from "./helpers";

const shim = createRequire(import.meta.url)("./e2e/obsidian-shim.cjs") as {
  FakeEl: new (tag?: string) => FakeEl;
};
interface FakeEl {
  attrs: Record<string, string | undefined>;
  tagName: string;
  textContent: string;
  disabled?: boolean;
  find(pred: (el: FakeEl) => boolean): FakeEl | null;
  hasClass(c: string): boolean;
  click(): Promise<unknown>;
}
const byData = (el: FakeEl, name: string): FakeEl | null => el.find((e) => e.attrs["data-ontomark"] === name);

const nodeTimers = {
  set: (fn: () => void, ms: number) => setTimeout(fn, ms) as unknown as number,
  clear: (h: number) => clearTimeout(h as unknown as NodeJS.Timeout),
};

/** A real api over the real engine and the fixture vault. */
async function realApi(): Promise<OntomarkApi> {
  const client = new OntomarkClient({ timers: nodeTimers, spawn: () => new InProcWorker(), wasmBytes: () => new ArrayBuffer(8), budget: 256 });
  const files = readVault();
  const vault: VaultPort = {
    listMarkdown: async () => files,
    read: async (p) => files.find((f) => f.path === p)?.text ?? "",
    process: async () => {
      throw new Error("read-only in this test");
    },
  };
  const api = new OntomarkApi(client, vault);
  await api.start("generic");
  return api;
}

/** The parts of the plugin a block or the query view uses, with the plugin's persistent event relay. */
function fakePlugin(api: unknown) {
  const listeners = new Set<(e: ChangeEvent) => void>();
  const plugin = {
    api,
    settings: { queryLimit: 100 },
    app: { metadataCache: { getFirstLinkpathDest: () => null } },
    subscribe: (l: (e: ChangeEvent) => void) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    emit: (e: ChangeEvent) => {
      for (const l of listeners) l(e);
    },
    jevConfig: () => ({ enabled: false }),
    reportError: () => undefined,
  };
  return plugin;
}
const asPlugin = (p: ReturnType<typeof fakePlugin>): OntomarkPlugin => p as unknown as OntomarkPlugin;

const select = (value: string): QueryResult => ({
  form: "select",
  variables: ["x"],
  rows: [{ x: { type: "literal", value, datatype: "http://www.w3.org/2001/XMLSchema#string" } }],
  truncated: false,
});

/** A stand-in api whose queries the test settles by hand. */
function manualApi() {
  const pending: { resolve: (r: QueryResult) => void; reject: (e: unknown) => void }[] = [];
  const api = {
    query: () => new Promise<QueryResult>((resolve, reject) => pending.push({ resolve, reject })),
    classify: async () => undefined,
    entityForPath: async () => undefined,
    onChange: () => () => undefined,
    status: (): Pick<Status, "generation" | "classification"> => ({ generation: 7, classification: null }),
  };
  return { api, pending };
}

describe("ontomark-sparql blocks", () => {
  it("two blocks in one note, refreshed at overlapping times, both render results", async () => {
    const api = await realApi();
    const plugin = fakePlugin(api);
    const source = "SELECT ?p ?o WHERE { __THIS__ ?p ?o }";
    const els = [new shim.FakeEl("div"), new shim.FakeEl("div")];
    const blocks = els.map((el) => new SparqlBlock(el as unknown as HTMLElement, asPlugin(plugin), source, "People/Rex.md"));
    for (const b of blocks) b.load();
    await Promise.all(blocks.map((b) => b.ready));
    // A second, overlapping refresh of both (what an edit's re-run timers do).
    const again = blocks.map((b) => b.run());
    await Promise.all(again);
    for (const [i, b] of blocks.entries()) {
      expect(b.lastError, `block ${i}`).toBeNull();
      expect((b.lastResult as { rows: unknown[] } | null)?.rows.length, `block ${i}`).toBeGreaterThan(0);
      expect(els[i].find((e) => e.tagName === "TABLE"), `block ${i}`).not.toBeNull();
    }
    for (const b of blocks) b.unload();
    api.dispose();
  });

  it("re-runs on the plugin's relay after a reindex replaced the api", async () => {
    const first = manualApi();
    const plugin = fakePlugin(first.api);
    const el = new shim.FakeEl("div");
    const block = new SparqlBlock(el as unknown as HTMLElement, asPlugin(plugin), "SELECT ?x WHERE { ?x ?p ?o }", "Note.md");
    block.load();
    await tick();
    first.pending[0].resolve(select("before"));
    await block.ready;
    expect(el.textContent).toContain("before");

    // Reindex: a new api, and the "indexed" event comes from it, through the plugin.
    const second = manualApi();
    plugin.api = second.api;
    plugin.emit({ type: "indexed", generation: 1 });
    await tick(450); // the block's re-run delay
    expect(second.pending).toHaveLength(1);
    second.pending[0].resolve(select("after"));
    await block.ready;
    expect(el.textContent).toContain("after");
    block.unload();
  });

  it("a quiet rejection (superseded, stale, disposed …) keeps what the block shows", async () => {
    const m = manualApi();
    const el = new shim.FakeEl("div");
    const block = new SparqlBlock(el as unknown as HTMLElement, asPlugin(fakePlugin(m.api)), "SELECT ?x WHERE { ?x ?p ?o }", "Note.md");
    block.load();
    await tick();
    m.pending[0].resolve(select("shown"));
    await block.ready;
    for (const code of ["superseded", "stale", "dead_epoch", "worker_restarted", "disposed"]) {
      const run = block.run();
      await tick();
      m.pending.at(-1)!.reject(new OntomarkError(code, "discarded"));
      await run;
      expect(block.lastError, code).toBeNull();
      expect(el.textContent, code).toContain("shown");
    }
    block.unload();
  });
});

describe("query view", () => {
  async function openView(api: unknown) {
    const view = new QueryView({ app: {} } as never, asPlugin(fakePlugin(api)));
    await view.onOpen();
    return view;
  }
  const results = (view: QueryView): FakeEl => (view as unknown as { resultsEl: FakeEl }).resultsEl;

  it("an older run rejected as superseded after a newer one rendered does not replace it", async () => {
    const m = manualApi();
    const view = await openView(m.api);
    const older = view.run();
    const newer = view.run();
    await tick();
    m.pending[1].resolve(select("newer"));
    await newer;
    m.pending[0].reject(new OntomarkError("superseded", "discarded: superseded"));
    await older;
    expect(view.lastError).toBeNull();
    expect(results(view).textContent).toContain("newer");
    expect(results(view).find((e) => e.hasClass("ontomark-error"))).toBeNull();
  });

  it("an older run that succeeds late does not replace the newer result either", async () => {
    const m = manualApi();
    const view = await openView(m.api);
    const older = view.run();
    const newer = view.run();
    await tick();
    m.pending[1].resolve(select("newer"));
    await newer;
    m.pending[0].resolve(select("older"));
    await older;
    expect(results(view).textContent).toContain("newer");
    expect(results(view).textContent).not.toContain("older");
  });

  it("a real error from the latest run is still shown", async () => {
    const m = manualApi();
    const view = await openView(m.api);
    const run = view.run();
    await tick();
    m.pending[0].reject(new OntomarkError("query_refused", "SERVICE is not supported"));
    await run;
    expect(view.lastError).toBe("query_refused: SERVICE is not supported");
  });
});

const classification = (over: Partial<Classification> = {}, elComplete = true): Classification => ({
  reasoner: { id: "r", version: "1", el_complete: elComplete, note: "" },
  subsumptions: [],
  equivalences: [],
  unsatisfiable: [],
  unsupported: [],
  policy: "all",
  complete: true,
  ...over,
});

describe("query result envelope", () => {
  const render = (r: QueryResult, env?: Parameters<typeof renderQueryResult>[2]): FakeEl => {
    const el = new shim.FakeEl("div");
    renderQueryResult(el as unknown as HTMLElement, r, env);
    return el;
  };

  it("names the dataset and generation, and warns when inferred triples rest on incomplete reasoning", () => {
    const el = render(select("a"), {
      dataset: "combined",
      generation: 4,
      classification: classification({ complete: false, unsupported: [{ axiom: null, reason: "EL_NOT_IMPLEMENTED: range" }] }),
    });
    expect(byData(el, "query-status")?.textContent).toBe("Dataset combined · generation 4 · reasoning incomplete");
    const warn = byData(el, "query-incomplete")?.textContent ?? "";
    expect(warn).toContain("1 axiom(s) not used");
    expect(warn).toContain("not evidence that a statement is false");
  });

  it("no warning for asserted triples, or for complete reasoning", () => {
    const asserted = render(select("a"), { dataset: "asserted", generation: 2, classification: null });
    expect(byData(asserted, "query-status")?.textContent).toBe("Dataset asserted · generation 2 · asserted triples only");
    expect(byData(asserted, "query-incomplete")).toBeNull();
    const complete = render(select("a"), { dataset: "inferred", generation: 2, classification: classification() });
    expect(byData(complete, "query-status")?.textContent).toContain("reasoning complete");
    expect(byData(complete, "query-incomplete")).toBeNull();
  });

  it("an inferred read with no known classification, or a reasoner short of EL, is flagged", () => {
    expect(byData(render(select("a"), { dataset: "inferred", generation: 2, classification: null }), "query-incomplete")).not.toBeNull();
    const notEl = render(select("a"), { dataset: "inferred", generation: 2, classification: classification({}, false) });
    expect(byData(notEl, "query-incomplete")?.textContent).toContain("not OWL 2 EL complete");
  });

  it("ASK false says that no match is not falsehood; ASK true says nothing extra", () => {
    const no = render({ form: "ask", boolean: false });
    expect(byData(no, "ask-note")?.textContent).toContain("does not show the statement is false");
    expect(byData(render({ form: "ask", boolean: true }), "ask-note")).toBeNull();
  });

  it("a block over the real engine carries the envelope, with the fixture's incomplete classification", async () => {
    const api = await realApi();
    const el = new shim.FakeEl("div");
    const block = new SparqlBlock(el as unknown as HTMLElement, asPlugin(fakePlugin(api)), "# dataset: combined\nSELECT ?p ?o WHERE { __THIS__ ?p ?o }", "People/Rex.md");
    block.load();
    await block.ready;
    expect(block.lastError).toBeNull();
    expect(byData(el, "query-status")?.textContent).toMatch(/^Dataset combined · generation \d+ · reasoning incomplete$/);
    expect(byData(el, "query-incomplete")).not.toBeNull();
    block.unload();
    api.dispose();
  });
});

describe("ingest review dialog", () => {
  const result: IngestAcceptResult = {
    path: "Bob.md",
    candidates: {
      document: "Bob.md",
      digest: "d",
      patch: null,
      accepted: [
        {
          key: "instance-of",
          predicate: "p",
          written: "[[Person]]",
          grounded: null,
          tier: null,
          datatype: null,
          evidence: [{ chunk: 0, span: { start: 0, end: 1 }, utf16: { start: 0, end: 1 }, quote: "Bob is a person" }],
          confidence: 0.5,
          method: "inferred",
        },
      ],
      withheld: [{ chunk: 0, key: "owns", value: "[[Rex]]", reason: { reason: "not_verified" }, evidence: null }],
      diagnostics: [],
    },
    preview: null,
  };

  /** Open the dialog, keep what it rendered (closing empties it), then cancel. */
  async function open(verification?: Verification): Promise<FakeEl> {
    const app = { modals: [] as { contentEl: FakeEl & { children: FakeEl[] } }[], workspace: {} };
    const done = confirmIngest(app as never, result, [], verification);
    const content = app.modals[0].contentEl;
    const kept = new shim.FakeEl("div") as FakeEl & { children: FakeEl[] };
    kept.children = [...content.children];
    await content.find((e) => e.attrs["data-ontomark-action"] === "cancel")!.click();
    expect(await done).toBe(false);
    return kept;
  }

  it("says what was checked: grounded and ready for review, not accepted", async () => {
    const text = (await open()).textContent;
    expect(text).toContain("Grounded, ready for review (1)");
    expect(text).not.toContain("Accepted (");
  });

  it("shows nothing about Jev while the option is off", async () => {
    expect(byData(await open(), "jev-status")).toBeNull();
  });

  it("shows each verification state explicitly", async () => {
    const verified = byData(await open({ state: "verified" }), "jev-status")!;
    expect(verified.attrs["data-jev-state"]).toBe("verified");

    const advisory = byData(await open({ state: "not_verified", reason: "timeout", withheld: false }), "jev-status")!;
    expect(advisory.attrs["data-jev-state"]).toBe("not_verified");
    expect(advisory.hasClass("ontomark-warning")).toBe(true);
    expect(advisory.textContent).toContain("Jev could not verify: timeout");
    expect(advisory.textContent).toContain("NOT checked");

    const closed = await open({ state: "not_verified", reason: "http-503", withheld: true });
    expect(byData(closed, "jev-status")!.textContent).toContain("Jev could not verify: http-503");
    expect(byData(closed, "jev-status")!.textContent).toContain("withheld (not_verified)");
    expect(byData(closed, "withheld")!.textContent).toContain("not_verified");
  });
});
