import type { TownSnapshot, Post } from "@hermesbook/shared";

export interface Board {
  id: string;
  name: string;
  factionId?: string;
  description: string;
}

export const boards: Board[] = [
  { id: "general", name: "General", description: "Town square chatter" },
  { id: "market", name: "Market", description: "Trade wool and oats" },
  { id: "hall", name: "Town Hall", description: "Votes and debates" },
  { id: "spit", name: "Spit Log", description: "Spit events and rivalries" },
  { id: "press", name: "Press", description: "The Daily Spit submissions" },
];

export function getBoardsForWorld(world: TownSnapshot): Board[] {
  const factionBoards: Board[] = world.factions.map((f) => ({
    id: `faction:${f.id}`,
    name: f.name,
    factionId: f.id,
    description: f.cause,
  }));
  return [...boards, ...factionBoards];
}

export function postToBoard(world: TownSnapshot, post: Post, boardId = "general"): void {
  // For MVP, boardId is stored as extra field on post (not in base type, but via index signature)
  (post as unknown as Record<string, unknown>).board = boardId;
  world.feed.unshift(post);
  if (world.feed.length > 400) world.feed.length = 400;
}

export function getThreads(world: TownSnapshot, boardId?: string): Post[] {
  let feed = world.feed;
  if (boardId) {
    feed = feed.filter((p) => (p as unknown as Record<string, unknown>).board === boardId || (boardId === "spit" && p.kind === "spit") || (boardId === "general" && !((p as unknown as Record<string, unknown>).board)));
  }
  return feed;
}

export function getThreadReplies(world: TownSnapshot, rootId: string): Post[] {
  return world.feed.filter((p) => p.replyTo === rootId);
}
