import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { parseMarkdown, type Block, type Inline } from "../src/ui/markdown";
import type { RestoredSegment } from "../src/engine/restore";
import { answer } from "../src/engine/answer";
import { MockSealedEngine } from "../src/engine/mocks";
import { createServices } from "../src/app/services";
import { AirlockSession, CONTINUE_REQUEST, type AssistantTurn } from "../src/app/session";

const t = (text: string): RestoredSegment => ({ kind: "text", text });
const raj: RestoredSegment = { kind: "restored", id: "PERSON_1", display: "Raj Patel", original: "[[PERSON_1]]" };

/** Flattens inline nodes to a readable string: **x** for strong, _x_ for em, `x` code, ⟨Raj Patel⟩ for atoms. */
function flat(nodes: readonly Inline[]): string {
  return nodes.map((n) => (n.t === "text" ? n.s : n.t === "atom" ? `⟨${n.seg.kind === "restored" ? n.seg.display : n.seg.kind}⟩` : n.t === "strong" ? `**${flat(n.c)}**` : n.t === "em" ? `_${flat(n.c)}_` : n.t === "code" ? `\`${n.s}\`` : "\n")).join("");
}
const shape = (blocks: Block[]): unknown[] =>
  blocks.map((b) => (b.t === "h" ? `h${b.level}:${flat(b.c)}` : b.t === "p" ? `p:${flat(b.c)}` : b.t === "hr" ? "hr" : { [b.ordered ? `ol@${b.start}` : "ul"]: b.items.map((i) => (i.sub ? [flat(i.c), shape([i.sub])[0]] : flat(i.c))) }));

describe("Markdown subset (FX-01, UX-03)", () => {
  it("renders the live answer's structure: rule, heading, bullets with bold, numbered list with nested bullets", () => {
    const md = "Here is an overview.\n\n---\n\n### What Is Going On\n\n* **Breach of Lease:** the heat is out.\n* **Health:** asthma.\n\n### Options\n\n1. **Send a notice**\n   * Write to Raj.\n   * Keep copies.\n\n2. **Call the city**";
    expect(shape(parseMarkdown([t(md)]))).toEqual([
      "p:Here is an overview.",
      "hr",
      "h2:What Is Going On",
      { ul: ["**Breach of Lease:** the heat is out.", "**Health:** asthma."] },
      "h2:Options",
      { "ol@1": [["**Send a notice**", { ul: ["Write to Raj.", "Keep copies."] }], "**Call the city**"] },
    ]);
  });

  it("keeps a restored detail as its own element inside a bold list item", () => {
    const blocks = parseMarkdown([t("* **Coordinate with "), raj, t("**\n* ask "), raj, t(" again")]);
    expect(shape(blocks)).toEqual([{ ul: ["**Coordinate with ⟨Raj Patel⟩**", "ask ⟨Raj Patel⟩ again"] }]);
  });

  it("shows an unclosed ** as typed while streaming, then bold once it closes", () => {
    expect(shape(parseMarkdown([t("The **lease cla")]))).toEqual(["p:The **lease cla"]);
    expect(shape(parseMarkdown([t("The **lease clause** says")]))).toEqual(["p:The **lease clause** says"]);
    const strong = parseMarkdown([t("The **lease clause** says")])[0] as Extract<Block, { t: "p" }>;
    expect(strong.c.some((n) => n.t === "strong")).toBe(true);
  });

  it("never treats underscores inside words as emphasis, and keeps code spans literal", () => {
    expect(shape(parseMarkdown([t("see rajesh_kumar_v2.pdf and `**not bold**`")]))).toEqual(["p:see rajesh_kumar_v2.pdf and `**not bold**`"]);
    const em = parseMarkdown([t("an _emphasised_ word")])[0] as Extract<Block, { t: "p" }>;
    expect(em.c.map((n) => n.t)).toEqual(["text", "em", "text"]);
    const snake = parseMarkdown([t("see rajesh_kumar_v2.pdf")])[0] as Extract<Block, { t: "p" }>;
    expect(snake.c.map((n) => n.t)).toEqual(["text"]);
  });

  it("has no links or images: a URL or Markdown link stays plain text", () => {
    const blocks = parseMarkdown([t("Visit [the portal](https://evil.example/?e="), raj, t(") or ![x](https://img.example/a.png)")]);
    const p = blocks[0] as Extract<Block, { t: "p" }>;
    expect(flat(p.c)).toBe("Visit [the portal](https://evil.example/?e=⟨Raj Patel⟩) or ![x](https://img.example/a.png)");
  });

  it("joins wrapped lines in a paragraph with line breaks", () => {
    expect(shape(parseMarkdown([t("Hi Raj,\nthe heater is broken.\n\nThanks")]))).toEqual(["p:Hi Raj,\nthe heater is broken.", "p:Thanks"]);
  });
});

describe("Cut-off answers (FX-01, UX-04)", () => {
  it("answer() flags a reply that hit the output-token limit", async () => {
    const services = await createServices("?demo=1");
    const engine = new MockSealedEngine("cloudFirst", () => "The heat is out and", "mock-gemini", true);
    const engines = { ...services.engines, sealed: () => engine };
    const s = new AirlockSession(services, { dial: "balanced", preference: "best", onboarded: true, backup: false });
    await s.load();
    await s.startReview("The heater is broken. What should I do?", { kind: "help" });
    const { sealed } = await import("../src/engine/gate").then(({ EgressGate }) => ({ sealed: new EgressGate(services.patterns, []).seal(s.getState().review!.result!.draft) }));
    let truncated: boolean | undefined;
    for await (const ev of answer({ engines, prompts: services.prompts, ledger: s.ledger, sealed, task: { kind: "help" }, restore: { entities: s.getState().review!.result!.draft.entities, userFirstName: null }, threadId: "t" })) {
      if (ev.kind === "finished") truncated = ev.outcome.truncated;
    }
    expect(truncated).toBe(true);
  });

  it("Continue sends a fixed, gate-checked follow-up with the thread's sealed history", async () => {
    const s = new AirlockSession(await createServices("?demo=1"), { dial: "balanced", preference: "best", onboarded: true, backup: false });
    await s.load();
    await s.startReview("The heater at 14 Elm St has been broken for weeks. What should I do?", { kind: "help" });
    await s.send();
    const id = s.getState().currentThreadId!;
    // Mark the demo answer as cut off.
    (s as unknown as { setThread: (id: string, f: (t: { turns: unknown[] }) => unknown) => void }).setThread(id, (th) => {
      const turns = [...th.turns];
      const last = turns[turns.length - 1] as AssistantTurn;
      turns[turns.length - 1] = { ...last, outcome: { ...last.outcome!, truncated: true } };
      return { ...th, turns };
    });
    const before = s.ledger.receipts.length;
    await s.continueAnswer(id);
    const th = s.getState().threads.find((x) => x.id === id)!;
    const user = th.turns[th.turns.length - 2]!;
    expect(user.kind === "user" && user.sealed?.value).toBe(CONTINUE_REQUEST);
    expect(user.kind === "user" && user.sealed?.gateReport.bypassed).toBe(false);
    const ai = th.turns[th.turns.length - 1] as AssistantTurn;
    expect(ai.status).toBe("done");
    expect(s.ledger.receipts.length).toBe(before + 1);
    // Nothing happens if the last answer wasn't cut off.
    await s.continueAnswer(id);
    expect(s.getState().threads.find((x) => x.id === id)!.turns.length).toBe(th.turns.length);
  });
});
