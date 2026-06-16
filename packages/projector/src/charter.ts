import type { AnyActorMessage, Charter, DefaultActorMessage } from "./types.ts";

export function createCharter<TActorMessage extends AnyActorMessage = DefaultActorMessage>(
  charter: Charter<TActorMessage>,
): Charter<TActorMessage> {
  return charter;
}
