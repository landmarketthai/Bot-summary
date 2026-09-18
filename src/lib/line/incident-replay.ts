import type { LineEvent, LineMessageEvent } from "./types";

export type ReplayTextStep = {
  type: "text";
  eventId: string;
  messageId: string;
  timestamp: number;
  text: string;
  redelivery?: boolean;
};

export type ReplayUnsendStep = {
  type: "unsend";
  eventId: string;
  timestamp: number;
  targetMessageId: string;
  redelivery?: boolean;
};

export type LineReplayStep = ReplayTextStep | ReplayUnsendStep;

export type LineIncidentReplay = {
  name: string;
  description?: string;
  source: {
    groupId: string;
    userId: string;
  };
  steps: LineReplayStep[];
  expect?: Record<string, unknown>;
};
function sourceOf(fixture: LineIncidentReplay) {
  return {
    type: "group" as const,
    groupId: fixture.source.groupId,
    userId: fixture.source.userId,
  };
}

export function buildLineReplayEvents(
  fixture: LineIncidentReplay,
): LineEvent[] {
  return fixture.steps.map((step, index) => {
    if (step.type === "unsend") {
      return {
        type: "unsend",
        webhookEventId: step.eventId,
        deliveryContext: { isRedelivery: step.redelivery ?? false },
        timestamp: step.timestamp,
        source: sourceOf(fixture),
        mode: "active",
        unsend: { messageId: step.targetMessageId },
      } satisfies LineEvent;
    }

    return {
      type: "message",
      webhookEventId: step.eventId,
      deliveryContext: { isRedelivery: step.redelivery ?? false },
      timestamp: step.timestamp,
      source: sourceOf(fixture),
      mode: "active",
      replyToken: `replay-reply-${index + 1}`,
      message: {
        id: step.messageId,
        type: "text",
        text: step.text,
        quoteToken: `replay-quote-${index + 1}`,
      },
    } satisfies LineMessageEvent;
  });
}

export async function replayLineIncident(
  fixture: LineIncidentReplay,
  deliver: (event: LineEvent, index: number) => Promise<void>,
): Promise<LineEvent[]> {
  const events = buildLineReplayEvents(fixture);
  for (let index = 0; index < events.length; index += 1) {
    await deliver(events[index]!, index);
  }
  return events;
}
