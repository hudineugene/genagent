"use server";

import { requireOwned } from "@/lib/access";
import { liveEvents, replayList, replaySteps } from "@/lib/agent/map-stats";

/** Карта агента: последние разговоры для повтора. */
export async function mapReplayList(agentId: string) {
  await requireOwned("agent", agentId);
  return (await replayList(agentId)).map((c) => ({ id: c.id, contact: c.contact || c.handle || "", channel: c.channel, channelId: c.channelId, at: c.at.getTime(), last: (c.last ?? "").slice(0, 80) }));
}

/** Карта агента: разговор по шагам (только разговор этого агента). */
export async function mapReplay(agentId: string, conversationId: string) {
  await requireOwned("agent", agentId);
  return replaySteps(agentId, conversationId);
}

/** Живой режим карты: события после since (мс). */
export async function mapLive(agentId: string, since: number) {
  await requireOwned("agent", agentId);
  return liveEvents(agentId, Math.max(Date.now() - 10 * 60_000, Number(since) || Date.now()));
}
