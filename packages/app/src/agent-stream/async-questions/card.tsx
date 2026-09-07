import React, { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { Check } from "lucide-react-native";
import { Button } from "@/components/ui/button";
import { EditingTextInput, type EditingTextInputHandle } from "@/components/ui/text-input";
import { QuestionOptionRow } from "@/components/question-form-card";
import { formatAsyncQuestionReply, type AsyncQuestionForm } from "./model";
import type { AgentAsyncUserInputQuestion } from "@getpaseo/protocol/agent-types";

function AsyncQuestionInput({
  index,
  question,
  initialValue,
  isSelected,
  editable,
  onChangeText,
  onRegisterHandle,
}: {
  index: number;
  question: AgentAsyncUserInputQuestion;
  initialValue: string;
  isSelected: boolean;
  editable: boolean;
  onChangeText: (text: string) => void;
  onRegisterHandle: (index: number, handle: EditingTextInputHandle | null) => void;
}) {
  const { t } = useTranslation();
  const handleRef = useRef<EditingTextInputHandle | null>(null);

  const setRef = useCallback(
    (handle: EditingTextInputHandle | null) => {
      handleRef.current = handle;
      onRegisterHandle(index, handle);
    },
    [index, onRegisterHandle],
  );

  useEffect(() => {
    if (isSelected && handleRef.current) {
      if (handleRef.current.getText() !== "") {
        handleRef.current.replaceText("");
      }
    }
  }, [isSelected]);

  return (
    <EditingTextInput
      ref={setRef}
      initialValue={initialValue}
      onChangeText={onChangeText}
      editable={editable}
      multiline
      accessibilityLabel={question.title}
      placeholder={t(
        question.options?.length
          ? "message.question.otherPlaceholder"
          : "message.question.answerPlaceholder",
      )}
      style={styles.input}
      testID={`async-question-input-${index}`}
    />
  );
}

export function AsyncQuestionCard({
  form,
  onSend,
}: {
  form: AsyncQuestionForm;
  onSend: (text: string) => Promise<void>;
}) {
  const { t } = useTranslation();
  const state = useSyncExternalStore(form.subscribe, form.getSnapshot, form.getSnapshot);
  const inputHandlesRef = useRef<Map<number, EditingTextInputHandle>>(new Map());

  const handleRegisterHandle = useCallback(
    (index: number, handle: EditingTextInputHandle | null) => {
      if (handle) {
        inputHandlesRef.current.set(index, handle);
      } else {
        inputHandlesRef.current.delete(index);
      }
    },
    [],
  );

  const handleToggle = useCallback(
    (qIndex: number, optIndex: number) => {
      const handle = inputHandlesRef.current.get(qIndex);
      if (handle && handle.getText() !== "") {
        handle.replaceText("");
      }
      form.select(qIndex, optIndex);
    },
    [form],
  );

  const entries = useMemo(
    () =>
      form.questions.map((question, index) => ({
        key: `${index}:${question.title}`,
        question,
        options: (question.options ?? []).map((label, optionIndex) => ({
          key: `${optionIndex}:${label}`,
          option: { label },
        })),
        onChangeText: (text: string) => form.write(index, text),
      })),
    [form],
  );
  const submit = useCallback(() => {
    void form.submit(onSend);
  }, [form, onSend]);

  const reply = formatAsyncQuestionReply(form.questions, state.answers);
  const sent = reply !== null && state.sentText === reply;

  return (
    <View style={styles.card} testID="async-question-card">
      {entries.map(({ key, question, options, onChangeText }, index) => (
        <View key={key} style={styles.question}>
          <Text style={styles.title}>{question.title}</Text>
          {options.map(({ key: optionKey, option }, optionIndex) => (
            <QuestionOptionRow
              key={optionKey}
              qIndex={index}
              optIndex={optionIndex}
              option={option}
              isSelected={state.answers[index]?.selected === optionIndex}
              multiSelect={false}
              isResponding={state.sending}
              onToggle={handleToggle}
            />
          ))}
          <AsyncQuestionInput
            index={index}
            question={question}
            initialValue={state.answers[index]?.text ?? ""}
            isSelected={state.answers[index]?.selected !== null}
            editable={!state.sending}
            onChangeText={onChangeText}
            onRegisterHandle={handleRegisterHandle}
          />
        </View>
      ))}
      {state.error ? (
        <Text style={styles.error} accessibilityRole="alert">
          {state.error}
        </Text>
      ) : null}
      <View style={styles.actions}>
        <Button
          size="sm"
          variant="outline"
          disabled={!reply || sent}
          loading={state.sending}
          leftIcon={sent ? Check : undefined}
          onPress={submit}
          testID="async-question-submit"
        >
          {t("message.question.submit")}
        </Button>
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  card: {
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    padding: theme.spacing[4],
    marginVertical: theme.spacing[2],
    gap: theme.spacing[4],
  },
  question: { gap: theme.spacing[2] },
  title: { color: theme.colors.foreground, fontSize: theme.fontSize.base, fontWeight: "500" },
  input: {
    color: theme.colors.foreground,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.md,
    padding: theme.spacing[2],
    minHeight: 40,
  },
  actions: { flexDirection: "row", justifyContent: "flex-end" },
  error: { color: theme.colors.destructive, fontSize: theme.fontSize.sm },
}));
