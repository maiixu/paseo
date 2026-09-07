import { describe, expect, it, vi } from "vitest";
import type { AgentAsyncUserInputQuestion } from "@getpaseo/protocol/agent-types";
import {
  createAsyncQuestionForm,
  formatAsyncQuestionReply,
  type AsyncQuestionAnswer,
} from "./model";

describe("formatAsyncQuestionReply", () => {
  it("formats a single question with option selected", () => {
    const questions: AgentAsyncUserInputQuestion[] = [
      { title: "Choose a deploy target", options: ["Staging", "Production"] },
    ];
    const answers: AsyncQuestionAnswer[] = [{ selected: 0, text: "" }];
    expect(formatAsyncQuestionReply(questions, answers)).toBe("Choose a deploy target\nStaging");
  });

  it("prioritizes free text over selected option", () => {
    const questions: AgentAsyncUserInputQuestion[] = [
      { title: "Choose a deploy target", options: ["Staging", "Production"] },
    ];
    const answers: AsyncQuestionAnswer[] = [{ selected: 0, text: "Canary cluster" }];
    expect(formatAsyncQuestionReply(questions, answers)).toBe(
      "Choose a deploy target\nCanary cluster",
    );
  });

  it("formats multiple questions with a mix of options and free text", () => {
    const questions: AgentAsyncUserInputQuestion[] = [
      { title: "Environment", options: ["Dev", "Prod"] },
      { title: "Run migrations?", options: ["Yes", "No"] },
      { title: "Special instructions", options: null },
    ];
    const answers: AsyncQuestionAnswer[] = [
      { selected: 1, text: "" },
      { selected: 0, text: "" },
      { selected: null, text: "Skip step 3" },
    ];
    expect(formatAsyncQuestionReply(questions, answers)).toBe(
      "Environment\nProd\n\nRun migrations?\nYes\n\nSpecial instructions\nSkip step 3",
    );
  });

  it("returns null if any question is unanswered", () => {
    const questions: AgentAsyncUserInputQuestion[] = [
      { title: "Environment", options: ["Dev", "Prod"] },
      { title: "Notes", options: null },
    ];
    // Notes is unanswered
    const answers: AsyncQuestionAnswer[] = [
      { selected: 0, text: "" },
      { selected: null, text: "" },
    ];
    expect(formatAsyncQuestionReply(questions, answers)).toBeNull();
  });

  it("returns null if text is whitespace only and no option is selected", () => {
    const questions: AgentAsyncUserInputQuestion[] = [{ title: "Notes", options: null }];
    const answers: AsyncQuestionAnswer[] = [{ selected: null, text: "   " }];
    expect(formatAsyncQuestionReply(questions, answers)).toBeNull();
  });

  it("returns null for empty questions or mismatched answer lengths", () => {
    expect(formatAsyncQuestionReply([], [])).toBeNull();
    const questions: AgentAsyncUserInputQuestion[] = [{ title: "Q1", options: ["A"] }];
    expect(formatAsyncQuestionReply(questions, [])).toBeNull();
  });
});

describe("createAsyncQuestionForm", () => {
  const sampleQuestions: AgentAsyncUserInputQuestion[] = [
    { title: "Target environment", options: ["Preview", "Production"] },
    { title: "Confirmation notes", options: null },
  ];

  it("initializes selection without auto-submitting", () => {
    const form = createAsyncQuestionForm(sampleQuestions);
    const snapshot = form.getSnapshot();

    expect(snapshot.sending).toBe(false);
    expect(snapshot.sentText).toBeNull();
    expect(snapshot.error).toBeNull();
    // Question with options defaults to option 0; question without options defaults to null
    expect(snapshot.answers[0]).toEqual({ selected: 0, text: "" });
    expect(snapshot.answers[1]).toEqual({ selected: null, text: "" });
  });

  it("notifies subscribers when answers change", () => {
    const form = createAsyncQuestionForm(sampleQuestions);
    const listener = vi.fn();
    const unsubscribe = form.subscribe(listener);

    form.select(0, 1);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(form.getSnapshot().answers[0]).toEqual({ selected: 1, text: "" });

    form.write(1, "Ready to go");
    expect(listener).toHaveBeenCalledTimes(2);
    expect(form.getSnapshot().answers[1]).toEqual({ selected: null, text: "Ready to go" });

    unsubscribe();
    form.select(0, 0);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("synchronously guards against duplicate submits", async () => {
    const questions: AgentAsyncUserInputQuestion[] = [
      { title: "Action", options: ["Continue", "Abort"] },
    ];
    const form = createAsyncQuestionForm(questions);

    let resolveSend!: () => void;
    const sendPromise = new Promise<void>((resolve) => {
      resolveSend = resolve;
    });
    const send = vi.fn().mockImplementation(() => sendPromise);

    // Call submit twice synchronously
    const firstSubmit = form.submit(send);
    const secondSubmit = form.submit(send);

    expect(form.getSnapshot().sending).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);

    resolveSend();
    await Promise.all([firstSubmit, secondSubmit]);

    expect(form.getSnapshot().sending).toBe(false);
    expect(form.getSnapshot().sentText).toBe("Action\nContinue");
  });

  it("handles error retention and allows retrying", async () => {
    const questions: AgentAsyncUserInputQuestion[] = [
      { title: "Action", options: ["Continue", "Abort"] },
    ];
    const form = createAsyncQuestionForm(questions);

    const failingSend = vi.fn().mockRejectedValue(new Error("Network disconnect"));
    await form.submit(failingSend);

    const errorSnapshot = form.getSnapshot();
    expect(errorSnapshot.sending).toBe(false);
    expect(errorSnapshot.sentText).toBeNull();
    expect(errorSnapshot.error).toBe("Network disconnect");

    // Retry should clear error and succeed if send succeeds
    const successfulSend = vi.fn().mockResolvedValue(undefined);
    await form.submit(successfulSend);

    const successSnapshot = form.getSnapshot();
    expect(successSnapshot.sending).toBe(false);
    expect(successSnapshot.sentText).toBe("Action\nContinue");
    expect(successSnapshot.error).toBeNull();
  });

  it("clears error on user answer modification", async () => {
    const questions: AgentAsyncUserInputQuestion[] = [
      { title: "Action", options: ["Continue", "Abort"] },
    ];
    const form = createAsyncQuestionForm(questions);

    const failingSend = vi.fn().mockRejectedValue(new Error("Server error"));
    await form.submit(failingSend);
    expect(form.getSnapshot().error).toBe("Server error");

    // Modifying answer clears error
    form.select(0, 1);
    expect(form.getSnapshot().error).toBeNull();
  });

  it("allows editing a sent answer and resubmission", async () => {
    const questions: AgentAsyncUserInputQuestion[] = [
      { title: "Branch", options: ["main", "feature"] },
    ];
    const form = createAsyncQuestionForm(questions);

    const send = vi.fn().mockResolvedValue(undefined);
    await form.submit(send);

    expect(form.getSnapshot().sentText).toBe("Branch\nmain");
    expect(send).toHaveBeenCalledTimes(1);

    // Submitting again without changes is a no-op
    await form.submit(send);
    expect(send).toHaveBeenCalledTimes(1);

    // Edit answer
    form.select(0, 1);
    expect(form.getSnapshot().answers[0]?.selected).toBe(1);

    // Resubmit updated answer
    await form.submit(send);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenLastCalledWith("Branch\nfeature");
    expect(form.getSnapshot().sentText).toBe("Branch\nfeature");
  });

  it("preserves pending state across subscription churn", async () => {
    const questions: AgentAsyncUserInputQuestion[] = [
      { title: "Action", options: ["Run", "Stop"] },
    ];
    const form = createAsyncQuestionForm(questions);

    let resolveSend!: () => void;
    const sendPromise = new Promise<void>((resolve) => {
      resolveSend = resolve;
    });
    const send = vi.fn().mockImplementation(() => sendPromise);

    const listener1 = vi.fn();
    const unsub1 = form.subscribe(listener1);

    // Start submit
    const submitPromise = form.submit(send);
    expect(form.getSnapshot().sending).toBe(true);

    // Unsubscribe listener 1 (simulating unmount)
    unsub1();

    // Subscribe listener 2 (simulating remount)
    const listener2 = vi.fn();
    const unsub2 = form.subscribe(listener2);

    // State is still sending
    expect(form.getSnapshot().sending).toBe(true);

    resolveSend();
    await submitPromise;

    expect(form.getSnapshot().sending).toBe(false);
    expect(form.getSnapshot().sentText).toBe("Action\nRun");
    expect(listener2).toHaveBeenCalled();

    unsub2();
  });
});
