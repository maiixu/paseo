import { z } from "zod";
import { DiagnosticsSchema, browserErrorMessage, type Diagnostics } from "./companion";

const ResponseSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("ok"), diagnostics: DiagnosticsSchema }),
  z.object({ status: z.literal("error"), error: z.string() }),
]);

function element(id: string): HTMLElement {
  const node = document.getElementById(id);
  if (node === null) {
    throw new Error(`Missing popup element: ${id}`);
  }
  return node;
}

const outcome = element("outcome");
const refresh = element("refresh");
const test = element("test");

function render(diagnostics: Diagnostics): void {
  element("permission").textContent = `Extension notifications: ${diagnostics.permission}`;
  const livePages = diagnostics.bindings.filter((binding) => binding.live);
  element("pages").textContent =
    `${livePages.length} connected page(s), ${diagnostics.bindings.length - livePages.length} retained tab binding(s)`;
  const list = element("history");
  list.replaceChildren();
  const traces = diagnostics.traces.slice(-10).toReversed();
  for (const trace of traces) {
    const row = document.createElement("li");
    const timestamp = new Date(trace.at).toLocaleTimeString();
    row.textContent = `${timestamp} · ${trace.stage}: ${trace.detail}`;
    list.append(row);
  }
  if (traces.length === 0) {
    const row = document.createElement("li");
    row.textContent = "No notification events received in this browser session.";
    list.append(row);
  }
}

async function request(action: "diagnostics" | "test-notification"): Promise<void> {
  refresh.setAttribute("disabled", "");
  test.setAttribute("disabled", "");
  outcome.textContent = action === "test-notification" ? "Sending test…" : "Loading…";
  outcome.className = "";
  try {
    const input: unknown = await chrome.runtime.sendMessage(action);
    const response = ResponseSchema.parse(input);
    if (response.status === "error") {
      outcome.textContent = response.error;
      outcome.className = "error";
      return;
    }
    render(response.diagnostics);
    outcome.textContent =
      action === "test-notification"
        ? "Chrome accepted the test. Confirm the banner yourself; macOS and Focus may hide it."
        : "Diagnostics updated.";
  } catch (error) {
    outcome.textContent = browserErrorMessage(error);
    outcome.className = "error";
  } finally {
    refresh.removeAttribute("disabled");
    test.removeAttribute("disabled");
  }
}

refresh.addEventListener("click", () => {
  void request("diagnostics");
});
test.addEventListener("click", () => {
  void request("test-notification");
});
void request("diagnostics");
