// The "Extract facts" lifecycle (src/ingest-run.ts) and the write step it ends
// in (OntomarkApi.applyPatch): a stopped run writes nothing, and a write that
// reached the disk is reported as applied even if the engine is gone.
import { describe, expect, it } from "vitest";
import { OntomarkApi } from "../src/api";
import type { VaultPort } from "../src/api";
import { OntomarkClient } from "../src/client";
import { runIngest } from "../src/ingest-run";
import type { IngestRunDeps } from "../src/ingest-run";
import type { AbortToken } from "../src/ingest-transport";
import type { IngestAcceptResult, ModelRequest, PatchProposal } from "../src/protocol";
import { InProcWorker } from "./helpers";

const BASE = "---\ntype: individual\n---\nBob is a person.\n";
const NEW = "---\ntype: individual\ninstance-of: [[Person]]\n---\nBob is a person.\n";

const proposal: PatchProposal = {
  path: "Bob.md",
  base_digest: "b",
  base_text: BASE,
  new_text: NEW,
  new_digest: "n",
  diff: "+instance-of: [[Person]]\n",
  edits: [],
  preserved_bytes: 0,
  no_op: false,
};

const request: ModelRequest = {
  contract: "ontomark-ingest/facts/1",
  note: { document: "Bob.md", digest: "b", iri: "urn:bob", kind: "individual", label: "Bob" },
  instructions: "",
  keys: [],
  chunks: [],
  response_schema: {},
};

const accepted: IngestAcceptResult = {
  path: "Bob.md",
  candidates: { document: "Bob.md", digest: "b", patch: null, accepted: [], withheld: [], diagnostics: [] },
  preview: proposal,
};

/** An in-memory vault holding one note, recording every write. */
function memVault(onProcess?: () => void): VaultPort & { text: string; writes: number } {
  const v = {
    text: BASE,
    writes: 0,
    listMarkdown: async () => [{ path: "Bob.md", text: v.text }],
    read: async () => v.text,
    process: async (_path: string, fn: (data: string) => string) => {
      const next = fn(v.text);
      v.text = next;
      v.writes++;
      onProcess?.();
      return next;
    },
  };
  return v;
}

const unstartedClient = (): OntomarkClient =>
  new OntomarkClient({ spawn: () => new InProcWorker(), wasmBytes: () => new ArrayBuffer(8) });

/** Deps over a real `applyPatch` and an in-memory vault; `hooks` lets a step set the abort token. */
function deps(run: AbortToken, hooks: { afterAccept?: () => void; afterJudge?: () => void; review?: () => boolean } = {}) {
  const vault = memVault();
  const api = new OntomarkApi(unstartedClient(), vault);
  const seen = { reviews: 0, applies: 0 };
  const d: IngestRunDeps = {
    plan: async () => ({ path: "Bob.md", digest: "b", request }),
    callModel: async () => [{ chunk: 0, assertions: [] }],
    accept: async () => {
      hooks.afterAccept?.();
      return accepted;
    },
    judge: hooks.afterJudge
      ? async (_a, _r, _rs, plain) => {
          hooks.afterJudge?.();
          return { result: plain, notes: [], outcome: "applied", verification: { state: "verified" } };
        }
      : null,
    review: async () => {
      seen.reviews++;
      return hooks.review ? hooks.review() : true;
    },
    applyPatch: (p, confirm) => {
      seen.applies++;
      return api.applyPatch(p, confirm);
    },
  };
  return { d, vault, seen };
}

describe("runIngest lifecycle", () => {
  it("an abort between accept and apply writes nothing and opens no dialog", async () => {
    const run: AbortToken = { aborted: false };
    const { d, vault, seen } = deps(run, { afterAccept: () => (run.aborted = true) });
    expect(await runIngest("Bob.md", d, run)).toEqual({ status: "aborted" });
    expect(seen).toEqual({ reviews: 0, applies: 0 });
    expect(vault.writes).toBe(0);
    expect(vault.text).toBe(BASE);
  });

  it("an abort during the Jev check writes nothing", async () => {
    const run: AbortToken = { aborted: false };
    const { d, vault, seen } = deps(run, { afterJudge: () => (run.aborted = true) });
    expect(await runIngest("Bob.md", d, run)).toEqual({ status: "aborted" });
    expect(seen.reviews).toBe(0);
    expect(vault.writes).toBe(0);
  });

  it("an unload while the review dialog is open turns a late Apply into no write", async () => {
    const run: AbortToken = { aborted: false };
    const { d, vault } = deps(run, {
      review: () => {
        run.aborted = true; // the plugin unloaded while the dialog was up ...
        return true; // ... and then the user pressed Apply
      },
    });
    expect((await runIngest("Bob.md", d, run)).status).toBe("declined");
    expect(vault.writes).toBe(0);
  });

  it("without an abort the reviewed patch is written", async () => {
    const run: AbortToken = { aborted: false };
    const { d, vault } = deps(run);
    expect((await runIngest("Bob.md", d, run)).status).toBe("applied");
    expect(vault.text).toBe(NEW);
  });
});

describe("applyPatch", () => {
  it("reports applied when the disk write succeeded but the engine update hit a disposed client", async () => {
    const client = unstartedClient();
    // The reindex (or unload) lands between the disk write and the engine update.
    const vault = memVault(() => client.dispose());
    const api = new OntomarkApi(client, vault);
    const indexed: number[] = [];
    api.onChange((e) => {
      if (e.type === "indexed") indexed.push(e.generation);
    });
    const outcome = await api.applyPatch(proposal, async () => true);
    expect(outcome).toEqual({ status: "applied", path: "Bob.md", digest: "n" });
    expect(vault.text).toBe(NEW);
    // The disposed engine did not take the update, so no "indexed" is claimed for it.
    expect(indexed).toEqual([]);
  });

  it("still refuses, writing nothing, when the file changed after planning", async () => {
    const vault = memVault();
    vault.text = "edited meanwhile\n";
    const api = new OntomarkApi(unstartedClient(), vault);
    expect(await api.applyPatch(proposal, async () => true)).toMatchObject({ status: "refused", code: "source_changed" });
    expect(vault.text).toBe("edited meanwhile\n");
  });
});
