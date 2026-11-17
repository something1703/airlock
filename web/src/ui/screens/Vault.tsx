import { useState } from "react";
import { useAirlock, useSession } from "../../app/context";
import type { PrivacyCategory } from "../../engine/types";
import type { VaultEntry } from "../../engine/vault";

const KINDS: { id: PrivacyCategory; label: string }[] = [
  { id: "person", label: "Person" }, { id: "org", label: "Organisation" }, { id: "location", label: "Place" }, { id: "contact", label: "Contact" }, { id: "id", label: "ID number" },
];

export function VaultScreen() {
  const s = useSession();
  const { vault } = useAirlock();
  const [name, setName] = useState("");
  const [aliases, setAliases] = useState("");
  const [category, setCategory] = useState<PrivacyCategory>("person");
  const [role, setRole] = useState("");

  async function add() {
    if (!name.trim()) return;
    const entry: VaultEntry = { id: crypto.randomUUID(), canonical: name.trim(), aliases: aliases.split(",").map((a) => a.trim()).filter(Boolean), category, roleHint: role.trim() ? `my ${role.trim()}` : null, isUser: false };
    await s.saveVault([...vault, entry]);
    setName(""); setAliases(""); setRole("");
  }

  return (
    <div className="stack">
      <div>
        <h1>Vault</h1>
        <p className="sub">Names and details Airlock always protects, even if the on-device model misses them. Encrypted and kept only in this browser — never synced.</p>
      </div>
      <div className="card stack" style={{ gap: 10 }}>
        <div className="row">
          <select className="field" value={category} onChange={(e) => setCategory(e.target.value as PrivacyCategory)} aria-label="Kind">{KINDS.map((k) => <option key={k.id} value={k.id}>{k.label}</option>)}</select>
          <input className="field" style={{ flex: 2, minWidth: 180 }} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Raj Patel" aria-label="Name or detail" />
          <input className="field" style={{ flex: 1, minWidth: 120 }} value={role} onChange={(e) => setRole(e.target.value)} placeholder="role, e.g. landlord" aria-label="Role" />
        </div>
        <div className="row">
          <input className="field" style={{ flex: 1 }} value={aliases} onChange={(e) => setAliases(e.target.value)} placeholder="Other ways you write it, comma-separated (e.g. Raj, Mr Patel)" aria-label="Aliases" />
          <button className="btn btn-primary" disabled={!name.trim()} onClick={() => void add()}>Add</button>
        </div>
      </div>
      <div className="card">
        {vault.length === 0 ? <p className="small">Nothing here yet.</p> : (
          <div className="entity-list">
            {vault.map((v) => (
              <div className="entity" key={v.id}>
                <div style={{ flex: 1 }}>
                  <div className="name">{v.canonical}{v.isUser ? " (you)" : ""}</div>
                  <div className="role">{KINDS.find((k) => k.id === v.category)?.label ?? v.category}{v.roleHint ? ` · ${v.roleHint}` : ""}{v.aliases.length ? ` · also “${v.aliases.join("”, “")}”` : ""}</div>
                </div>
                <button className="btn btn-ghost btn-danger" aria-label={`Remove ${v.canonical}`} onClick={() => void s.saveVault(vault.filter((x) => x.id !== v.id))}>Remove</button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
