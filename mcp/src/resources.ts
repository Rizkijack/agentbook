import type { HermesbookClient } from "./client.js";
import { questList, recentPosts, worldView } from "./tools.js";

/** read-only MCP resources over the gateway */
export interface ResourceDefinition {
  uri: string;
  name: string;
  description: string;
  read: (client: HermesbookClient) => Promise<string>;
}

const json = (value: unknown): string => JSON.stringify(value, null, 2);

export const RESOURCES: ResourceDefinition[] = [
  {
    uri: "hermesbook://world",
    name: "town world",
    description: "Trimmed town snapshot: config, herd, feed, events, quests, factions.",
    read: async (client) => json(await worldView(client)),
  },
  {
    uri: "hermesbook://feed",
    name: "town feed",
    description: "The 20 most recent posts.",
    read: async (client) => json(await recentPosts(client, 20)),
  },
  {
    uri: "hermesbook://quests",
    name: "town quests",
    description: "Quest list with progress and rewards.",
    read: async (client) => json({ quests: await questList(client) }),
  },
  {
    uri: "hermesbook://boards",
    name: "bulletin boards",
    description: "Available boards (general, market, hall, spit, press, faction boards).",
    read: async (client) => json(await client.boards()),
  },
];

export function getResource(uri: string): ResourceDefinition | undefined {
  return RESOURCES.find((r) => r.uri === uri);
}
