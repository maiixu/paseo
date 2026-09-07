import React, { act } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentAsyncUserInputQuestion } from "@getpaseo/protocol/agent-types";
import { createAsyncQuestionForm } from "./model";
import { AsyncQuestionCard } from "./card";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => {
      if (key === "message.question.submit") return "Submit";
      if (key === "message.question.otherPlaceholder") return "Other...";
      if (key === "message.question.answerPlaceholder") return "Type your answer...";
      return key;
    },
  }),
}));

describe("AsyncQuestionCard", () => {
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("React", React);
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it("renders questions, default option selection, and text input", () => {
    const questions: AgentAsyncUserInputQuestion[] = [
      { title: "Target cluster", options: ["cluster-a", "cluster-b"] },
    ];
    const form = createAsyncQuestionForm(questions);
    const onSend = vi.fn().mockResolvedValue(undefined);

    render(<AsyncQuestionCard form={form} onSend={onSend} />);

    expect(screen.getByTestId("async-question-card")).toBeDefined();
    expect(screen.getByText("Target cluster")).toBeDefined();
    expect(screen.getByText("cluster-a")).toBeDefined();
    expect(screen.getByText("cluster-b")).toBeDefined();

    const input = screen.getByTestId("async-question-input-0") as HTMLInputElement;
    expect(input.placeholder).toBe("Other...");
    expect(input.value).toBe("");

    const submitBtn = screen.getByTestId("async-question-submit");
    expect(submitBtn).toBeDefined();
    // Default option 0 is selected, so reply is valid and submit is enabled
    expect(submitBtn.getAttribute("aria-disabled")).not.toBe("true");
  });

  it("clears custom text input when a radio option is clicked", () => {
    const questions: AgentAsyncUserInputQuestion[] = [
      { title: "Target cluster", options: ["cluster-a", "cluster-b"] },
    ];
    const form = createAsyncQuestionForm(questions);
    const onSend = vi.fn().mockResolvedValue(undefined);

    render(<AsyncQuestionCard form={form} onSend={onSend} />);

    const input = screen.getByTestId("async-question-input-0") as HTMLInputElement;
    const radioB = screen.getByRole("radio", { name: "cluster-b" });
    const radioA = screen.getByRole("radio", { name: "cluster-a" });

    // Initially option 0 is selected
    expect(radioA.getAttribute("aria-checked")).toBe("true");

    // Type custom input
    act(() => {
      fireEvent.change(input, { target: { value: "cluster-custom" } });
    });
    expect(input.value).toBe("cluster-custom");
    expect(form.getSnapshot().answers[0]?.text).toBe("cluster-custom");
    expect(form.getSnapshot().answers[0]?.selected).toBeNull();
    expect(radioA.getAttribute("aria-checked")).toBe("false");
    expect(radioB.getAttribute("aria-checked")).toBe("false");

    // Click radio option B
    act(() => {
      fireEvent.click(radioB);
    });

    // Custom input must be imperatively cleared
    expect(input.value).toBe("");
    expect(form.getSnapshot().answers[0]?.selected).toBe(1);
    expect(form.getSnapshot().answers[0]?.text).toBe("");
    expect(radioB.getAttribute("aria-checked")).toBe("true");
  });

  it("handles multi-question cards and disables submit when any question is unanswered", () => {
    const questions: AgentAsyncUserInputQuestion[] = [
      { title: "Target cluster", options: ["cluster-a", "cluster-b"] },
      { title: "Deployment reason", options: null },
    ];
    const form = createAsyncQuestionForm(questions);
    const onSend = vi.fn().mockResolvedValue(undefined);

    render(<AsyncQuestionCard form={form} onSend={onSend} />);

    const submitBtn = screen.getByTestId("async-question-submit");
    // Question 2 is free text and not yet answered, so submit is disabled
    expect(submitBtn.getAttribute("aria-disabled")).toBe("true");

    const reasonInput = screen.getByTestId("async-question-input-1") as HTMLInputElement;
    expect(reasonInput.placeholder).toBe("Type your answer...");

    // Fill in the reason
    act(() => {
      fireEvent.change(reasonInput, { target: { value: "Weekly release" } });
    });

    // Now submit is enabled
    expect(submitBtn.getAttribute("aria-disabled")).not.toBe("true");
  });

  it("submits the formatted reply and enters sent state", async () => {
    const questions: AgentAsyncUserInputQuestion[] = [
      { title: "Target cluster", options: ["cluster-a", "cluster-b"] },
    ];
    const form = createAsyncQuestionForm(questions);
    const onSend = vi.fn().mockResolvedValue(undefined);

    render(<AsyncQuestionCard form={form} onSend={onSend} />);

    const submitBtn = screen.getByTestId("async-question-submit");
    await act(async () => {
      fireEvent.click(submitBtn);
    });

    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend).toHaveBeenCalledWith("Target cluster\ncluster-a");

    // Once sent, the button is disabled to prevent re-sending unchanged answers
    expect(submitBtn.getAttribute("aria-disabled")).toBe("true");
    expect(form.getSnapshot().sentText).toBe("Target cluster\ncluster-a");
  });

  it("allows editing sent answers and resubmitting", async () => {
    const questions: AgentAsyncUserInputQuestion[] = [
      { title: "Target cluster", options: ["cluster-a", "cluster-b"] },
    ];
    const form = createAsyncQuestionForm(questions);
    const onSend = vi.fn().mockResolvedValue(undefined);

    render(<AsyncQuestionCard form={form} onSend={onSend} />);

    const submitBtn = screen.getByTestId("async-question-submit");
    await act(async () => {
      fireEvent.click(submitBtn);
    });

    expect(onSend).toHaveBeenCalledTimes(1);
    expect(submitBtn.getAttribute("aria-disabled")).toBe("true");

    // User changes selection to option B
    const radioB = screen.getByRole("radio", { name: "cluster-b" });
    act(() => {
      fireEvent.click(radioB);
    });

    // Submit button is re-enabled for resubmission
    expect(submitBtn.getAttribute("aria-disabled")).not.toBe("true");

    await act(async () => {
      fireEvent.click(submitBtn);
    });

    expect(onSend).toHaveBeenCalledTimes(2);
    expect(onSend).toHaveBeenLastCalledWith("Target cluster\ncluster-b");
    expect(submitBtn.getAttribute("aria-disabled")).toBe("true");
  });

  it("displays error with alert accessibility role and permits retry", async () => {
    const questions: AgentAsyncUserInputQuestion[] = [
      { title: "Target cluster", options: ["cluster-a"] },
    ];
    const form = createAsyncQuestionForm(questions);
    const onSend = vi
      .fn()
      .mockRejectedValueOnce(new Error("Failed to reach daemon"))
      .mockResolvedValueOnce(undefined);

    render(<AsyncQuestionCard form={form} onSend={onSend} />);

    const submitBtn = screen.getByTestId("async-question-submit");
    await act(async () => {
      fireEvent.click(submitBtn);
    });

    expect(onSend).toHaveBeenCalledTimes(1);
    // Error is rendered with accessibilityRole="alert"
    const alert = screen.getByRole("alert");
    expect(alert).toBeDefined();
    expect(alert.textContent).toBe("Failed to reach daemon");

    // Button is enabled for retry
    expect(submitBtn.getAttribute("aria-disabled")).not.toBe("true");

    // Retry submit
    await act(async () => {
      fireEvent.click(submitBtn);
    });

    expect(onSend).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(submitBtn.getAttribute("aria-disabled")).toBe("true");
  });

  it("preserves state across unmount and remount with same form instance", () => {
    const questions: AgentAsyncUserInputQuestion[] = [{ title: "Notes", options: null }];
    const form = createAsyncQuestionForm(questions);
    const onSend = vi.fn().mockResolvedValue(undefined);

    // Initial render and typing
    const { unmount } = render(<AsyncQuestionCard form={form} onSend={onSend} />);
    const input = screen.getByTestId("async-question-input-0") as HTMLInputElement;
    act(() => {
      fireEvent.change(input, { target: { value: "Draft remarks" } });
    });
    expect(form.getSnapshot().answers[0]?.text).toBe("Draft remarks");

    // Unmount (simulating virtualized list unmounting offscreen row)
    unmount();

    // Remount with same form instance
    render(<AsyncQuestionCard form={form} onSend={onSend} />);
    const remountedInput = screen.getByTestId("async-question-input-0") as HTMLInputElement;
    expect(remountedInput.value).toBe("Draft remarks");
  });
});
