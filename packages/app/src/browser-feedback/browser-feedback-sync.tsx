import { useEffect } from "react";
import { getIsElectron, isNative } from "@/constants/platform";
import { getIsAppActivelyVisible } from "@/utils/app-visibility";
import { getBrowserCompanion } from "./companion-client";
import { useCurrentBrowserAgent } from "./current-agent";

function BrowserFeedbackSyncInner() {
  const current = useCurrentBrowserAgent();

  useEffect(() => {
    const companion = getBrowserCompanion();
    if (!companion) return;
    const publish = () =>
      companion.publishState({ ...current, visible: getIsAppActivelyVisible() });
    publish();
    const reconnect = window.setInterval(() => companion.hello(), 15000);
    document.addEventListener("visibilitychange", publish);
    window.addEventListener("focus", publish);
    window.addEventListener("blur", publish);
    return () => {
      window.clearInterval(reconnect);
      document.removeEventListener("visibilitychange", publish);
      window.removeEventListener("focus", publish);
      window.removeEventListener("blur", publish);
    };
  }, [current]);

  return null;
}

export function BrowserFeedbackSync() {
  return isNative || getIsElectron() ? null : <BrowserFeedbackSyncInner />;
}
