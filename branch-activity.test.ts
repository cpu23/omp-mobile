import { describe, expect, test } from "bun:test";
import { collectBranchActivity } from "./extension";

/**
 * `collectBranchActivity` reads the latest todo snapshot and task results from
 * one session branch. The host (omp 17.3.7, `tools/todo.ts`
 * `getLatestTodoPhasesFromEntries`) records user todo edits as `custom`
 * entries — `{type: "custom", customType: "user_todo_edit", data: {phases}}` —
 * rather than `todo` tool results, which the mobile activity dock previously
 * dropped from its branch scan.
 */

type TestPhase = {
  name: string;
  tasks: Array<{ content: string; status: string }>;
};

function todoResult(phases: TestPhase[], id = "todo-1"): unknown {
  return {
    type: "message",
    message: {
      role: "toolResult",
      toolName: "todo",
      toolCallId: id,
      details: { phases },
    },
  };
}

function userTodoEdit(phases: unknown): unknown {
  return { type: "custom", customType: "user_todo_edit", data: { phases } };
}

const FOUNDATION: TestPhase[] = [
  {
    name: "Foundation",
    tasks: [{ content: "Scaffold crate", status: "completed" }],
  },
];

const AUTH: TestPhase[] = [
  { name: "Auth", tasks: [{ content: "Wire OAuth", status: "in_progress" }] },
];

describe("collectBranchActivity todos", () => {
  test("reads a user todo edit custom entry", () => {
    const { todos } = collectBranchActivity([userTodoEdit(FOUNDATION)]);
    expect(todos).toEqual(FOUNDATION);
  });

  test("an empty user todo edit clears the previous snapshot", () => {
    const { todos } = collectBranchActivity([
      todoResult(FOUNDATION),
      userTodoEdit([]),
    ]);
    expect(todos).toEqual([]);
  });

  test("branch order decides between user edits and todo results", () => {
    expect(
      collectBranchActivity([userTodoEdit(FOUNDATION), todoResult(AUTH)]).todos,
    ).toEqual(AUTH);
    expect(
      collectBranchActivity([todoResult(FOUNDATION), userTodoEdit(AUTH)]).todos,
    ).toEqual(AUTH);
  });

  test("ignores other custom entries and malformed todo edits", () => {
    const { todos } = collectBranchActivity([
      todoResult(FOUNDATION),
      { type: "custom", customType: "goal-continuation", data: { phases: AUTH } },
      userTodoEdit("not-an-array"),
      { type: "custom", customType: "user_todo_edit" },
      { type: "custom", customType: "user_todo_edit", data: {} },
    ]);
    expect(todos).toEqual(FOUNDATION);
  });

  test("still reads todo tool results and task results", () => {
    const branch = [
      todoResult(AUTH, "todo-2"),
      {
        type: "message",
        message: {
          role: "toolResult",
          toolName: "task",
          toolCallId: "task-call-1",
          details: {
            progress: [
              {
                index: 0,
                id: "agent-1",
                description: "Scan repository",
                status: "running",
              },
            ],
          },
        },
      },
    ];
    const { todos, tasks } = collectBranchActivity(branch);
    expect(todos).toEqual(AUTH);
    expect(tasks.get("task-call-1")?.agents.map((agent) => agent.id)).toEqual([
      "agent-1",
    ]);
  });
});
