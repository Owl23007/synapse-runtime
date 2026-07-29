import type { LineEvent } from "./types.js";

/**
 * 收集与目标事件存在因果或关联关系的事件
 */
export function collectRelatedEvents(
  events: readonly LineEvent[],
  target: LineEvent,
  causationChain: readonly LineEvent[]
): readonly LineEvent[] {
  const eventsById = new Map(events.map((event) => [event.id, event]));
  const connectedIds = new Set([target.id, ...causationChain.map((event) => event.id)]);
  let changed = true;

  while (changed) {
    changed = false;
    const connectedEvents = [...connectedIds]
      .map((eventId) => eventsById.get(eventId))
      .filter((event): event is LineEvent => event !== undefined);
    const correlationIds = definedValues(connectedEvents.map((event) => event.correlationId));
    const taskIds = definedValues(connectedEvents.map((event) => event.taskId));
    const normalizedEventIds = definedValues(connectedEvents.map((event) => event.sourceNormalizedEventId));
    const referencedEventIds = definedValues(
      connectedEvents.flatMap((event) => [event.sourceEventId, event.causationEventId])
    );

    for (const candidate of events) {
      if (connectedIds.has(candidate.id)) {
        continue;
      }

      const linked =
        referencedEventIds.has(candidate.id) ||
        (candidate.sourceEventId !== undefined && connectedIds.has(candidate.sourceEventId)) ||
        (candidate.causationEventId !== undefined && connectedIds.has(candidate.causationEventId)) ||
        (candidate.correlationId !== undefined && correlationIds.has(candidate.correlationId)) ||
        (candidate.taskId !== undefined && taskIds.has(candidate.taskId)) ||
        (candidate.sourceNormalizedEventId !== undefined && normalizedEventIds.has(candidate.sourceNormalizedEventId));

      if (linked) {
        connectedIds.add(candidate.id);
        changed = true;
      }
    }
  }

  const causationIds = new Set(causationChain.map((event) => event.id));
  return events.filter((event) => connectedIds.has(event.id) && event.id !== target.id && !causationIds.has(event.id));
}

function definedValues(values: readonly (string | undefined)[]): ReadonlySet<string> {
  return new Set(values.filter((value): value is string => value !== undefined));
}
