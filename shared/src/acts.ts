/**
 * The verbs a resident is allowed to be *doing*.
 *
 * Why this list exists: `act` was the one unvalidated dimension on the agent
 * gateway. `place` is gated on `LOCATION_BY_ID` and `skill` on
 * `isNpcSkillId`, but `act` was only length-bounded, so any string reached
 * `mind.doing.act`, was persisted to `town.json`, and was re-broadcast to every
 * client through `/api/snapshot`. Unbounded agent input in shared state.
 *
 * The list is the union of two sources, and both halves matter:
 *
 *  - Verbs the simulation itself produces (`simbrain.ts`) or that carry real
 *    simulator meaning: `tickNeeds` applies a need delta for graze/drink/sleep/
 *    argue/talk/work/wander/stroll/explore/spit, and `quests.ts` matches on
 *    talk/argue/graze/work.
 *  - Verbs the agent-facing documentation advertises (`mcp/src/tools.ts`,
 *    `frontend/src/views/mcpInfo.ts`) that carry no simulator meaning of their
 *    own: move, rest, speak, chat. These are accepted unchanged so that
 *    documented agent behaviour does not break.
 *
 * `shake` is deliberately NOT here. It is a client-side render state written by
 * the canvas when a resident is spat on (`frontend/src/canvas/engine.ts`); it is
 * never an agent-authored act.
 */

export const RESIDENT_ACTS = [
  // movement
  "move",
  "wander",
  "stroll",
  "explore",
  // labour
  "work",
  "graze",
  "drink",
  "sleep",
  "rest",
  // social
  "talk",
  "argue",
  "speak",
  "chat",
  // the hostility event
  "spit",
] as const;

export type ResidentAct = (typeof RESIDENT_ACTS)[number];

/** Verbs with no simulator meaning, kept only for documented agent compatibility. */
export const ACTS_WITHOUT_SIM_SEMANTICS: ReadonlySet<string> = new Set([
  "move",
  "rest",
  "speak",
  "chat",
]);

const ACT_IDS: ReadonlySet<string> = new Set(RESIDENT_ACTS);

/** true when `act` names a verb a resident may perform (never throws). */
export function isResidentAct(act: string | undefined | null): act is ResidentAct {
  return typeof act === "string" && ACT_IDS.has(act);
}

/**
 * Message for a rejected verb. Lists the allowed set so a confused agent can
 * correct itself on the next call instead of guessing again.
 */
export function unknownActMessage(act: string): string {
  return `unknown act "${act}"; allowed: ${RESIDENT_ACTS.join(", ")}`;
}