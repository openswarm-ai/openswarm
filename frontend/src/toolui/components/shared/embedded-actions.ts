import type { ActionsProp } from "./actions-config";

export type EmbeddedActionHandler<TState> = (
  actionId: string,
  state: TState,
) => void | Promise<void>;

export type EmbeddedBeforeActionHandler<TState> = (
  actionId: string,
  state: TState,
) => boolean | Promise<boolean>;

export interface EmbeddedActionsProps<TState> {
  actions?: ActionsProp;
  onAction?: EmbeddedActionHandler<TState>;
  onBeforeAction?: EmbeddedBeforeActionHandler<TState>;
}
