import type { TestContext } from 'vitest';

// Same shape as server/testing/story.ts — duplicated so the frontend vitest
// run doesn't have to reach up into the server tree (keeps tsconfig scopes
// clean).
export function story(ctx: TestContext, description: string): void {
  (ctx.task.meta as Record<string, unknown>).story = description;
}
