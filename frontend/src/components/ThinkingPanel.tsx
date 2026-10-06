import { NPC_WORKFLOW, npcSkillLabel } from "@slopagentbook/shared";
import type { Resident } from "@slopagentbook/shared";

/**
 * The slice of `Resident.mind.doing` the HUD reads. Kept partial on purpose:
 * snapshots written before the skill existed carry no `skill`, and a stale
 * order may arrive without `why` — the panel shows a placeholder instead of
 * crashing (08 §12: no field may throw on absence).
 */
export type ThinkingDoing = Partial<Resident["mind"]["doing"]>;

export interface ThinkingLine {
  /** english row caption: skill | reason | goal */
  readonly label: string;
  readonly value: string;
}

const PLACEHOLDER = "-";

/**
 * skill → reason → goal, as three plain rows — pure so the test can assert the
 * thinking summary without mounting the DOM. Known rule ids become human labels
 * (npcSkillLabel), unknown ids fall back to the raw id, absent fields to "-".
 */
export function buildThinkingLines(doing: ThinkingDoing | undefined): ThinkingLine[] {
  const skillId = typeof doing?.skill === "string" && doing.skill !== "" ? doing.skill : undefined;
  const skill = skillId ? npcSkillLabel(skillId) ?? skillId : PLACEHOLDER;
  const reason = doing?.why?.trim() || PLACEHOLDER;
  const act = doing?.act?.trim() || PLACEHOLDER;
  const place = doing?.placeName?.trim() || doing?.place?.trim() || PLACEHOLDER;
  const goal = act === PLACEHOLDER && place === PLACEHOLDER
    ? PLACEHOLDER
    : [act, place].filter((part) => part !== PLACEHOLDER).join(" @ ");
  return [
    { label: "skill", value: skill },
    { label: "reason", value: reason },
    { label: "goal", value: goal },
  ];
}

/** Small HUD card: what the followed resident's agent decided, and why. */
export function ThinkingPanel({ doing }: { doing?: ThinkingDoing }) {
  return (
    <div data-testid="thinking-panel" className="mono" style={{ display: "grid", gap: 3 }}>
      {buildThinkingLines(doing).map((line) => (
        <div key={line.label} data-testid="thinking-line" style={{ display: "grid", gridTemplateColumns: "52px 1fr", gap: 8, alignItems: "baseline" }}>
          <span className="faint" style={{ fontSize: 9, letterSpacing: "0.14em", textTransform: "uppercase" }}>{line.label}</span>
          <span data-testid={`thinking-${line.label}`} style={{ fontSize: 11, color: "var(--ink)" }}>{line.value}</span>
        </div>
      ))}
      <div className="faint" style={{ fontSize: 9, letterSpacing: "0.06em", marginTop: 2 }} title="NPC agent loop">
        {NPC_WORKFLOW.join(" → ")}
      </div>
    </div>
  );
}
