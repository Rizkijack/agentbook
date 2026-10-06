---
name: npc-agent
description: How a agentbook resident thinks — the prioritized decision rules and the perceive → appraise → decide → act → speak → remember workflow that turn every need into an order on the town map. Read before changing NPC decision behavior.
---

# NPC Agent Skill

## Purpose

This skill defines how a resident (NPC) of agentbook decides what to do each
simulated turn. It is written for humans first, but it must stay in lockstep
with the machine-readable rules the code actually executes:

- **Human document:** this file (`skills/npc-agent/SKILL.md`).
- **Machine source of truth:** [`shared/src/skills.ts`](../../shared/src/skills.ts)
  (`NPC_SKILLS`, `NpcSkillRule`, `NPC_WORKFLOW`, `npcSkillLabel`).
- **Consumer:** `backend/src/simbrain.ts` walks `NPC_SKILLS` in priority order
  and applies the first rule whose `when` predicate holds; the winning rule id
  travels on `Decision.skill` → `OrderEvent.skill` / `mind.doing.skill` (with
  the stated reason as `why`) so the UI can show what the resident is
  thinking.

If you change one side, change the other. The synchronization check is:

```bash
pnpm --filter @slopagentbook/shared test   # parses this file, fails on drift
pnpm --filter backend test              # every rule branch keeps its act/place
```

## Rules

Evaluated strictly top-down: rule 1 wins whenever it triggers, rule 2 only if
rule 1 did not fire, and so on. Higher priority always beats lower priority
when two triggers are satisfied at the same time.

| Priority | Skill id | Label | Trigger | Acts | Places |
| ---: | --- | --- | --- | --- | --- |
| 1 | `rest-night` | Night Rest | Night and tired above the trait threshold | `sleep`, `talk` | `barn`, `fire` |
| 2 | `drink-water` | Thirst | Thirst above 0.6 | `drink` | `pond`, `square` |
| 3 | `eat-food` | Hunger | Hunger above 0.6 | `graze` | `trough`, `meadowW`, `meadowE`, `orchard`, `northMeadow`, `southMeadow`, `eastMeadow`, `westOrchard`, `market` |
| 4 | `seek-company` | Lonely | Effective loneliness above the trait threshold | `talk`, `argue` | `square`, `tavern`, `hall`, `baths`, `fire`, `market`, `board`, `inn`, `chapel`, `theatre`, `arcade`, `lodge`, `bandstand`, `aviary`, `hedgeMaze`, `rosewalk`, `disputation` |
| 5 | `low-spirits` | Low Spirits | Spirits below -0.6 (55% of eligible turns decline) | `argue`, `sleep` | `square`, `tavern`, `hall`, `baths`, `fire`, `market`, `board`, `inn`, `chapel`, `theatre`, `arcade`, `lodge`, `bandstand`, `aviary`, `hedgeMaze`, `rosewalk`, `disputation`, `barn`, `pens`, `stables`, `farmhouse`, `barracks`, `northStables`, `byre`, `paddock`, `sheepfold`, `hermitage`, `bogHut` |
| 6 | `wander-town` | Wander | Nothing urgent — rolls the wander chance (base 0.42) | `wander`, `stroll`, `explore`, `work`, `talk` | `square`, `hall`, `market`, `tavern`, `press`, `bank`, `vault`, `library`, `booth`, `clinic`, `school`, `post`, `baths`, `station`, `barn`, `shed`, `mill`, `pens`, `pond`, `dock`, `meadowW`, `meadowE`, `orchard`, `trough`, `fire`, `board`, `stables`, `granary`, `warehouse`, `chapel`, `inn`, `smithy`, `farmhouse`, `theatre`, `depot`, `garage`, `tower`, `arcade`, `forge`, `lodge`, `observatory`, `exchange`, `gatehouse`, `tollhouse`, `barracks`, `watchtower`, `beacon`, `northStables`, `curtainWall`, `outerGate`, `wharf`, `boathouse`, `netloft`, `saltWarehouse`, `ferrySlip`, `chandlery`, `riverWall`, `greenhouse`, `orangery`, `apiary`, `bandstand`, `aviary`, `hedgeMaze`, `rosewalk`, `foundry`, `kiln`, `oreShed`, `foundryCrane`, `quarryOffice`, `charcoalYard`, `slagHeap`, `scriptorium`, `lectureHall`, `anatomy`, `printHouse`, `observatoryAnnex`, `disputation`, `archive`, `byre`, `threshingBarn`, `paddock`, `dryingYard`, `sheepfold`, `dairy`, `cemetery`, `chapelOfBones`, `hermitage`, `charnel`, `bonehouse`, `peatWorks`, `charcoalKiln`, `bogHut`, `millpond`, `northMeadow`, `southMeadow`, `eastMeadow`, `westOrchard`, `riverRun`, `riverMouth`, `eastFen` |
| 7 | `busy-graze` | Busy Grazing | Keeps busy — 18% roll | `graze` | `meadowW` |
| 8 | `work-job` | Work | Resident has a job with a home location and it is elsewhere | `work` | `shed`, `pens`, `meadowW`, `paddock`, `mill`, `trough`, `market`, `granary`, `millpond`, `library`, `press`, `school`, `archive`, `scriptorium`, `bank`, `hall`, `exchange`, `orchard`, `dairy`, `meadowE`, `stables`, `sheepfold`, `southMeadow`, `observatory`, `printHouse`, `vault`, `smithy`, `forge`, `foundry`, `station`, `square`, `post`, `depot`, `garage`, `wharf`, `gatehouse`, `tower`, `chapel`, `beacon`, `watchtower` |
| 9 | `stroll-on` | Keep Moving | Always fires — the chain never ends on an idle resident | `stroll` | `square`, `tavern`, `hall`, `baths`, `fire`, `market`, `board`, `inn`, `chapel`, `theatre`, `arcade`, `lodge`, `bandstand`, `aviary`, `hedgeMaze`, `rosewalk`, `disputation` |

## Workflow

Every turn runs these six stages, in order, once per resident:

| Stage | What happens |
| --- | --- |
| `perceive` | Gather context: needs, day clock, current location, nearby residents, traits, job, spirits, recent feed/events. |
| `appraise` | Weigh the context: trait-adjusted thresholds, effective loneliness, night vs. day, spirit drift. |
| `decide` | Walk `NPC_SKILLS` by priority, take the first rule whose `when` predicate holds, and pick act + place + reason. |
| `act` | Apply the decision: validate the place, tick needs, drift spirits, move the resident, emit the `order` event (carrying `skill` + `why`). |
| `speak` | Optionally generate speech, thread it into the feed, and update relationships/memories. |
| `remember` | Store the speech as a memory and record the decision in `mind.doing` (`act`, `place`, `why`, `skill`). |

## Main rules

- **Urgent needs beat desires.** Survival instincts (night rest, thirst,
  hunger) always win over socializing, wandering, or work — that is what the
  priority column enforces.
- **Nothing idles.** The last rule (`stroll-on`) is unconditional, so a
  resident always ends a turn in motion.
- **Thresholds are trait-aware.** Tiredness and loneliness triggers shift with
  traits (`unflappable`/`dreamy`, `loyal`/`gruff`); spirits sharpen or numb
  loneliness.
- **Deterministic order, stochastic action.** Which rule fires is decided by
  the table; rolls only choose the variant (pond vs. fountain, talk vs.
  argue, which wander spot) inside the winning rule.
- **Every decision is explainable.** The winner's id (`skill`) and its reason
  sentence (`why`) travel with the order event — never drop either when
  touching the decision path.
