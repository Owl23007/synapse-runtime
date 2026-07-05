import { eventProcessKey } from "../context/session.js";
import type { EventProcessBeginInput, EventProcessState, EventProcessStore } from "./types.js";

export class InMemoryEventProcessStore implements EventProcessStore {
  readonly #states = new Map<string, EventProcessState>();

  async begin(input: EventProcessBeginInput): Promise<EventProcessState> {
    const id = eventProcessKey(input);
    const existing = this.#states.get(id);

    if (existing !== undefined) {
      return existing;
    }

    const state: EventProcessState = { id, status: "received", updatedAt: new Date().toISOString() };
    this.#states.set(id, state);
    return state;
  }

  async update(id: string, patch: Partial<Omit<EventProcessState, "id" | "updatedAt">>): Promise<EventProcessState> {
    const existing = this.#states.get(id);
    if (existing === undefined) {
      throw new Error(`Event process state "${id}" does not exist.`);
    }

    const next: EventProcessState = { ...existing, ...patch, updatedAt: new Date().toISOString() };
    this.#states.set(id, next);
    return next;
  }
}
