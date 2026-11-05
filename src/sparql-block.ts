// The `ontomark-sparql` fenced block: a SPARQL query written in a note, run
// against the local graph and rendered as a table in reading view, re-run
// when the index or classification changes.
//
// After Dot Triples by Cristian Vasquez (https://github.com/cristianvasquez/dot-triples-plugin,
// MIT), whose `dot-sparql` blocks showed the shape; see ADR-OBS-004.
import { MarkdownRenderChild } from "obsidian";
import type { MarkdownPostProcessorContext } from "obsidian";
import { OntomarkError, isQuiet } from "./client";
import type { QueryResult } from "./protocol";
import type OntomarkPlugin from "./main";
import { describeUnresolved, rewriteSparql, scanSparql } from "./sparql-rewrite";
import type { NoteReference } from "./sparql-rewrite";
import { queryEnvelope, renderQueryResult } from "./views/query-render";

export const SPARQL_BLOCK = "ontomark-sparql";

/** Delay before a block re-runs after the graph changed, so a burst of edits runs once. */
const RERUN_DELAY_MS = 400;

/** Numbers block instances, so each one is its own consumer channel in the generation guard. */
let blockSeq = 0;

export class SparqlBlock extends MarkdownRenderChild {
  lastResult: QueryResult | null = null;
  lastError: string | null = null;
  /** Resolves when the run started by `onload` has rendered; tests await it. */
  ready: Promise<void> = Promise.resolve();
  private unsubscribe: (() => void) | null = null;
  private rerun: number | null = null;
  /**
   * The guard treats a channel as one consumer (latest wins), so every block
   * needs its own: two blocks in one note sharing the note's path would
   * supersede each other on every refresh.
   */
  private readonly channel: string;
  /** Bumped by every run; only the latest run may touch the display. */
  private runSeq = 0;

  constructor(
    containerEl: HTMLElement,
    private readonly plugin: OntomarkPlugin,
    private readonly source: string,
    private readonly sourcePath: string,
  ) {
    super(containerEl);
    this.channel = `sparql-block:${sourcePath}#${++blockSeq}`;
  }

  override onload(): void {
    this.containerEl.addClass("ontomark-block");
    // The plugin's relay, not `api.onChange`: a reindex replaces the api, and
    // a listener on the old one would never hear from the new one.
    this.unsubscribe = this.plugin.subscribe((e) => {
      if (e.type !== "indexed" && e.type !== "classified") return;
      if (this.rerun !== null) window.clearTimeout(this.rerun);
      this.rerun = window.setTimeout(() => {
        this.rerun = null;
        this.ready = this.run();
      }, RERUN_DELAY_MS);
    });
    this.ready = this.run();
  }

  override onunload(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.rerun !== null) window.clearTimeout(this.rerun);
    this.rerun = null;
    this.runSeq++; // a run still in flight must not render into an unloaded block
  }

  /** Resolve the block's references, run the query and render the outcome. */
  async run(): Promise<void> {
    const el = this.containerEl;
    const seq = ++this.runSeq;
    const current = (): boolean => seq === this.runSeq;
    try {
      const iris = await this.resolveReferences();
      if (!current()) return;
      const rewrite = rewriteSparql(this.source, (ref) => iris.get(keyOf(ref)) ?? null);
      if (!rewrite.ok) {
        this.fail(describeUnresolved(rewrite.unresolved));
        return;
      }
      const limit = this.plugin.settings.queryLimit;
      const api = this.plugin.api;
      let result: QueryResult;
      try {
        result = await api.query(rewrite.sparql, rewrite.dataset, limit, this.channel);
      } catch (err) {
        if (!(err instanceof OntomarkError) || err.code !== "not_classified") throw err;
        await api.classify();
        // A newer run may have started while this one classified; its query must not be superseded by this retry.
        if (!current()) return;
        result = await api.query(rewrite.sparql, rewrite.dataset, limit, this.channel);
      }
      if (!current()) return;
      this.lastResult = result;
      this.lastError = null;
      renderQueryResult(el, result, queryEnvelope(api, rewrite.dataset));
    } catch (err) {
      // Overtaken (a newer run, an edit, a restarted worker, a reindex): keep
      // what is shown; whatever overtook this run schedules the next one.
      if (isQuiet(err) || !current()) return;
      const code = err instanceof OntomarkError ? err.code : "error";
      const message = err instanceof Error ? err.message : String(err);
      this.fail(`${code}: ${message}`);
    }
  }

  private fail(text: string): void {
    this.lastResult = null;
    this.lastError = text;
    this.containerEl.empty();
    this.containerEl.createDiv({ text, cls: "ontomark-error" });
  }

  /**
   * IRIs for every reference the block makes. `__THIS__` is the entity whose
   * note holds the block; a link resolves the way Obsidian resolves it from
   * this note, then to the entity indexed at that path.
   */
  private async resolveReferences(): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    const refs = scanSparql(this.source).spans.map((s) => s.ref);
    for (const ref of refs) {
      const key = keyOf(ref);
      if (out.has(key)) continue;
      const path = ref.kind === "this" ? this.sourcePath : this.plugin.app.metadataCache.getFirstLinkpathDest(ref.target, this.sourcePath)?.path;
      if (!path) continue;
      const entity = await this.plugin.api.entityForPath(path);
      if (entity) out.set(key, entity.iri);
    }
    return out;
  }
}

function keyOf(ref: NoteReference): string {
  return ref.kind === "this" ? "\u0000this" : `link:${ref.target}`;
}

/** Register the block processor; one `SparqlBlock` per fenced block, owned by the renderer. */
export function registerSparqlBlock(plugin: OntomarkPlugin): void {
  plugin.registerMarkdownCodeBlockProcessor(SPARQL_BLOCK, (source: string, el: HTMLElement, ctx: MarkdownPostProcessorContext) => {
    ctx.addChild(new SparqlBlock(el, plugin, source, ctx.sourcePath));
  });
}
