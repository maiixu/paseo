import { describe, expect, it, vi } from "vitest";
import { AttentionDelivery, attentionDeliveryId } from "./attention-delivery";

describe("attention delivery", () => {
  it("shares one in-flight notification and remembers successful acceptance", async () => {
    const delivery = new AttentionDelivery();
    let finish!: (accepted: boolean) => void;
    const send = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          finish = resolve;
        }),
    );
    const first = delivery.deliver("turn-1", send);
    const duplicate = delivery.deliver("turn-1", send);
    await Promise.resolve();

    expect(send).toHaveBeenCalledTimes(1);
    finish(true);
    expect(await Promise.all([first, duplicate])).toEqual([true, true]);
    expect(await delivery.deliver("turn-1", send)).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("allows a failed notification to be retried on the same event", async () => {
    const delivery = new AttentionDelivery();
    const send = vi
      .fn<() => Promise<boolean>>()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);

    expect(await delivery.deliver("turn-1", send)).toBe(false);
    expect(await delivery.deliver("turn-1", send)).toBe(true);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("releases the in-flight event after the sender throws", async () => {
    const delivery = new AttentionDelivery();
    const send = vi
      .fn<() => Promise<boolean>>()
      .mockImplementationOnce(() => {
        throw new Error("Notification constructor failed");
      })
      .mockResolvedValueOnce(true);

    await expect(delivery.deliver("turn-1", send)).rejects.toThrow(
      "Notification constructor failed",
    );
    expect(await delivery.deliver("turn-1", send)).toBe(true);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("does not let another agent's pending notification block delivery", async () => {
    const delivery = new AttentionDelivery();
    let finish!: (accepted: boolean) => void;
    const pending = delivery.deliver(
      "agent-a-turn-1",
      () =>
        new Promise<boolean>((resolve) => {
          finish = resolve;
        }),
    );
    const sendOther = vi.fn(async () => true);

    expect(await delivery.deliver("agent-b-turn-1", sendOther)).toBe(true);
    expect(sendOther).toHaveBeenCalledTimes(1);
    finish(false);
    expect(await pending).toBe(false);
  });
});

// Distinct questions can arrive in one millisecond; a replay can arrive later.
it("identifies questions independently of event timestamps", async () => {
  const delivery = new AttentionDelivery();
  const send = vi.fn(async () => true);
  for (const [requestId, timestamp] of [
    ["q1", "same-time"],
    ["q2", "same-time"],
    ["q1", "later-time"],
  ]) {
    await delivery.deliver(
      attentionDeliveryId("host", { agentId: "agent", reason: "permission", timestamp, requestId }),
      send,
    );
  }
  expect(send).toHaveBeenCalledTimes(2);
});
