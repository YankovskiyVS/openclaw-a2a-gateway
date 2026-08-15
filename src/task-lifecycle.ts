import type { RequestContext } from "@a2a-js/sdk/server";

const INITIAL_TASK_PUBLISHED = Symbol("openclaw-a2a.initial-task-published");

type LifecycleRequestContext = RequestContext & {
  [INITIAL_TASK_PUBLISHED]?: boolean;
};

/** Mark that this request's stream has already been opened with a full Task. */
export function markInitialTaskPublished(requestContext: RequestContext): void {
  (requestContext as LifecycleRequestContext)[INITIAL_TASK_PUBLISHED] = true;
}

/** Durable task state is not evidence that a Task was published on this stream. */
export function hasInitialTaskPublished(requestContext: RequestContext): boolean {
  return (requestContext as LifecycleRequestContext)[INITIAL_TASK_PUBLISHED] === true;
}
