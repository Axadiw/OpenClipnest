import type { TestContext } from 'vitest';

// Attach a one- or two-sentence user-story description to the current test so
// it shows up in the aggregated HTML report. Call it as the first statement
// inside each `test(...)` / `it(...)` body, passing the Vitest test context.
//
//   test('rejects bad credentials', (ctx) => {
//     story(ctx, 'Użytkownik widzi błąd po złych danych logowania.');
//     // ...
//   });
export function story(ctx: TestContext, description: string): void {
  (ctx.task.meta as Record<string, unknown>).story = description;
}
