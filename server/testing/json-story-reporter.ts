import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

// Custom Vitest reporter that emits a JSON file with per-test status,
// duration, error info, captured logs, and the `story` attached via
// server/testing/story.ts (or frontend/src/test-story.ts). Consumed by
// scripts/build-test-report.ts.
//
// Output path comes from the STORY_REPORT_OUTPUT env var and is resolved
// relative to process.cwd() — so it works from the repo root and from the
// frontend/ subdir alike (see package.json `test` scripts).
export default class JsonStoryReporter {
  // Vitest 4+: use the new onTestRunEnd hook (receives TestModule instances).
  onTestRunEnd(testModules: any[] = []): void {
    this.flush(testModules.map(moduleToFile));
  }

  // Fallback for older/newer Vitest variants that still fire onFinished(files).
  onFinished(files: any[] = []): void {
    // Only used when onTestRunEnd did not run.
    if (!files?.length) return;
    this.flush(files);
  }

  private flush(files: any[]): void {
    const rawOut = process.env.STORY_REPORT_OUTPUT || 'test-results/vitest.json';
    const outputFile = resolve(process.cwd(), rawOut);
    const payload = {
      timestamp: new Date().toISOString(),
      files: files.map(serializeFile),
    };
    mkdirSync(dirname(outputFile), { recursive: true });
    writeFileSync(outputFile, JSON.stringify(payload, null, 2));
  }
}

// Convert a Vitest 4 TestModule into the legacy `File` shape the rest of this
// file already understands. Reads the real Vitest 4 API:
//   - TestModule.children has .array() for direct children (TestCase|TestSuite)
//   - TestCase: .name, .result() => {state, errors}, .diagnostic() => {duration},
//     .meta (property, set via ctx.task.meta inside the test body), .logs() =>
//     iterable of {type, content}. TestSuite has .name + .children.
function childrenArray(node: any): any[] {
  const c = node?.children;
  if (!c) return [];
  if (typeof c.array === 'function') return c.array();
  if (Array.isArray(c)) return c;
  return [];
}

function moduleToFile(mod: any): any {
  const diag = typeof mod.diagnostic === 'function' ? mod.diagnostic() : {};
  return {
    filepath: mod.moduleId ?? mod.filepath ?? '',
    name: mod.moduleId ?? mod.filepath ?? '',
    result: { state: undefined, duration: diag?.duration ?? 0 },
    tasks: childrenArray(mod).map(nodeToTask),
  };
}

function nodeToTask(node: any): any {
  // Suites expose .children; test cases expose .result() / .diagnostic().
  const isSuite = node?.type === 'suite' || (!!node?.children && typeof node?.result !== 'function');
  if (isSuite) {
    return {
      type: 'suite',
      name: node.name ?? '',
      tasks: childrenArray(node).map(nodeToTask),
    };
  }

  const result = typeof node.result === 'function' ? node.result() : node.result;
  const diag = typeof node.diagnostic === 'function' ? node.diagnostic() : undefined;
  const meta = (typeof node.meta === 'function' ? node.meta() : node.meta) ?? {};

  // Logs: .logs() returns an iterable / array in Vitest 4. Older runs have
  // node.logs as a plain array.
  let logs: any[] = [];
  try {
    if (typeof node.logs === 'function') logs = Array.from(node.logs() ?? []);
    else if (Array.isArray(node.logs)) logs = node.logs;
  } catch {
    logs = [];
  }

  const errors = (result?.errors ?? []).map((e: any) => ({ message: e?.message, stack: e?.stack }));

  return {
    type: 'test',
    name: node.name ?? '',
    meta,
    logs,
    result: {
      state: result?.state,
      duration: diag?.duration ?? 0,
      errors,
    },
  };
}

function serializeFile(file: any): any {
  return {
    filepath: file.filepath ?? file.name ?? '',
    name: file.name ?? '',
    state: file.result?.state ?? 'unknown',
    durationMs: file.result?.duration ?? 0,
    errorMessage: file.result?.errors?.[0]?.message ?? null,
    tasks: (file.tasks || []).map(serializeTask),
  };
}

function serializeTask(task: any): any {
  if (task.type === 'suite') {
    return {
      type: 'suite',
      name: task.name ?? '',
      tasks: (task.tasks || []).map(serializeTask),
    };
  }
  return {
    type: 'test',
    name: task.name ?? '',
    state: task.result?.state ?? 'skipped',
    durationMs: task.result?.duration ?? 0,
    story: (task.meta && task.meta.story) ?? null,
    errorMessage: task.result?.errors?.[0]?.message ?? null,
    errorStack: task.result?.errors?.[0]?.stack ?? null,
    logs: (task.logs || []).map((l: any) => ({
      type: l?.type ?? 'log',
      content: typeof l?.content === 'string' ? l.content : String(l?.content ?? ''),
    })),
  };
}
