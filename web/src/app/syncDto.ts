// Firestore documents for sealed-history sync (docs/05 §6.1). Pure: no Firebase imports, so the rules tests
// in functions/test can write exactly these shapes to the emulator.
//
// INV-7: every field comes from SealedText, the model's placeholder text, or receipt metadata — never raw
// text, restored text, entity maps or the receipt's local `outboundText`.
import type { Receipt } from "../engine/hashchain";
import type { Route, SealedText } from "../engine/types";

export interface ThreadDto {
  createdAt: Date;
  updatedAt: Date;
  /** Generated from sealed text on device. */
  title: string;
  lastRoute: Route;
  turnCount: number;
}

export interface TurnDto {
  createdAt: Date;
  role: "user" | "assistant";
  /** Placeholders only. */
  sealedText: string;
  /** The rendered legend exactly as sent (user turns only). */
  legend?: string;
  route: Route;
  modelVersion: string;
  receiptId: string | null;
}

export type ReceiptDto = Omit<Receipt, "outboundText">;

export function threadDto(t: { title: string; createdAt: number; updatedAt: number; lastRoute: Route; turnCount: number }): ThreadDto {
  return { createdAt: new Date(t.createdAt), updatedAt: new Date(t.updatedAt), title: t.title.slice(0, 80), lastRoute: t.lastRoute, turnCount: t.turnCount };
}

export function userTurnDto(sealed: SealedText, route: Route, modelVersion: string, receiptId: string | null, at: number): TurnDto {
  const legend = sealed.legend.map((l) => `[[${l.placeholder}]] — ${l.description}`).join("\n");
  return { createdAt: new Date(at), role: "user", sealedText: sealed.value, ...(legend ? { legend } : {}), route, modelVersion, receiptId };
}

/** The model's own output — placeholders, before restore (AnswerOutcome.modelText). */
export function assistantTurnDto(modelText: string, route: Route, modelVersion: string, receiptId: string | null, at: number): TurnDto {
  return { createdAt: new Date(at), role: "assistant", sealedText: modelText, route, modelVersion, receiptId };
}

export function receiptDto(r: Receipt): ReceiptDto {
  const { outboundText: _local, ...rest } = r;
  return { ...rest, counts: { ...r.counts }, gate: { passed: r.gate.passed, checks: [...r.gate.checks] }, latencyMs: { ...r.latencyMs } };
}
