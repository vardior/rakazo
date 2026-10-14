import type { MessageBlock } from "@rakazo/contracts";
import { useState } from "react";
import { Text, View } from "react-native";
import { rpc } from "../lib/api";
import { useI18n } from "../lib/i18n";
import { useMobileTokens } from "../lib/native";
import { errorText } from "../lib/user-error";
import { NativeActionButton } from "./native-action-button";

export function FailedRunNotice({
  target,
  block,
  speaker,
  canRetry,
  onRefresh,
}: {
  target: { botId: string } | { groupId: string };
  block: Extract<MessageBlock, { kind: "text" }>;
  speaker?: string;
  canRetry: boolean;
  onRefresh: () => Promise<void>;
}) {
  const tokens = useMobileTokens();
  const { t } = useI18n();
  const [pending, setPending] = useState(false);
  const [retried, setRetried] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function retry() {
    if (pending || !block.runFailure) return;
    setPending(true);
    setError(null);
    try {
      await rpc("threads/retry", { ...target, runId: block.runFailure.runId });
      setRetried(true);
      await onRefresh().catch(() => undefined);
    } catch (err) {
      setError(errorText(err, t("Could not retry")));
    } finally {
      setPending(false);
    }
  }
  return (
    <View
      style={{
        gap: 8,
        borderRadius: 20,
        backgroundColor: tokens.muted,
        paddingHorizontal: 14,
        paddingVertical: 12,
      }}
    >
      {speaker ? (
        <Text style={{ color: tokens.mutedForeground, fontSize: 12.5, fontWeight: "600" }}>
          {speaker}
        </Text>
      ) : null}
      <Text style={{ color: tokens.foreground, fontSize: 15.5, lineHeight: 23 }}>{block.text}</Text>
      {canRetry && !retried ? (
        <NativeActionButton
          label={t("Retry")}
          prominence="secondary"
          size="compact"
          busy={pending}
          onPress={() => void retry()}
        />
      ) : null}
      {error ? (
        <Text accessibilityRole="alert" style={{ color: tokens.destructive }}>
          {error}
        </Text>
      ) : null}
    </View>
  );
}
