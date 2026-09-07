import type { AgentAsyncUserInputQuestion } from "@getpaseo/protocol/agent-types";

interface QuestionMetadata {
  delivery?: "async";
  questions?: AgentAsyncUserInputQuestion[];
}

export function asyncQuestionMetadata(item: QuestionMetadata): QuestionMetadata {
  return {
    ...(item.delivery ? { delivery: item.delivery } : {}),
    ...(item.questions ? { questions: item.questions } : {}),
  };
}

export function isAsyncQuestionMessage(item: QuestionMetadata): boolean {
  return item.delivery === "async" || Boolean(item.questions?.length);
}

export function areSeparateAsyncMessages(
  previous: QuestionMetadata & { messageId?: string },
  next: QuestionMetadata & { messageId?: string },
): boolean {
  return (
    (isAsyncQuestionMessage(previous) || isAsyncQuestionMessage(next)) &&
    (!previous.messageId || previous.messageId !== next.messageId)
  );
}
