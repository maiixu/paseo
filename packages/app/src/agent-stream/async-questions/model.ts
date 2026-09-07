import type { AgentAsyncUserInputQuestion } from "@getpaseo/protocol/agent-types";

export interface AsyncQuestionAnswer {
  selected: number | null;
  text: string;
}

export function formatAsyncQuestionReply(
  questions: readonly AgentAsyncUserInputQuestion[],
  answers: readonly AsyncQuestionAnswer[],
): string | null {
  if (questions.length === 0 || questions.length !== answers.length) return null;
  const parts: string[] = [];
  for (let index = 0; index < questions.length; index++) {
    const question = questions[index]!;
    const answer = answers[index]!;
    const value =
      answer.text.trim() ||
      (answer.selected === null ? "" : question.options?.[answer.selected]?.trim()) ||
      "";
    if (!value) return null;
    parts.push(`${question.title}\n${value}`);
  }
  return parts.join("\n\n");
}

/** Kept by message identity in the stream, so virtualization cannot resend a pending reply. */
export function createAsyncQuestionForm(questions: readonly AgentAsyncUserInputQuestion[]) {
  let snapshot = {
    answers: questions.map(
      (question): AsyncQuestionAnswer => ({
        selected: question.options?.length ? 0 : null,
        text: "",
      }),
    ),
    sending: false,
    sentText: null as string | null,
    error: null as string | null,
  };
  const listeners = new Set<() => void>();
  const update = (next: typeof snapshot) => {
    snapshot = next;
    for (const listener of listeners) listener();
  };
  const change = (index: number, answer: AsyncQuestionAnswer) => {
    if (snapshot.sending || !questions[index]) return;
    update({
      ...snapshot,
      answers: snapshot.answers.map((value, i) => (i === index ? answer : value)),
      error: null,
    });
  };
  return {
    questions,
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    select: (index: number, selected: number) => change(index, { selected, text: "" }),
    write: (index: number, text: string) => change(index, { selected: null, text }),
    async submit(send: (text: string) => Promise<void>) {
      const text = formatAsyncQuestionReply(questions, snapshot.answers);
      if (!text || snapshot.sending || snapshot.sentText === text) return;
      update({ ...snapshot, sending: true, error: null });
      try {
        await send(text);
        update({ ...snapshot, sending: false, sentText: text });
      } catch (error) {
        update({
          ...snapshot,
          sending: false,
          error:
            error instanceof Error ? error.message : "Could not send the reply. Please try again.",
        });
      }
    },
  };
}

export type AsyncQuestionForm = ReturnType<typeof createAsyncQuestionForm>;
