import { useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import { verifyTwoFactorCode } from "../lib/api";
import { APP_NAME } from "../lib/brand";
import { useI18n } from "../lib/i18n";
import { useMobileTokens } from "../lib/native";
import type { TwoFactorMethod } from "../lib/two-factor";
import { TwoFactorRestartError } from "../lib/two-factor";
import { NativeActionButton } from "./native-action-button";

/**
 * The second sign-in step for an account with two-factor on: a code from the authenticator app,
 * or one of the account's backup codes. The password step already ran; `onRestart` returns to it
 * when the pending sign-in is gone.
 */
export function TwoFactorStep({
  onDone,
  onRestart,
  onCancel,
}: {
  onDone: () => void;
  onRestart: (message: string) => void;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  const tokens = useMobileTokens();
  const [method, setMethod] = useState<TwoFactorMethod>("totp");
  const [code, setCode] = useState("");
  const [trustDevice, setTrustDevice] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function submit() {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      await verifyTwoFactorCode(code, { method, trustDevice });
      onDone();
    } catch (err) {
      const message = err instanceof Error && err.message ? err.message : t("Could not continue");
      if (err instanceof TwoFactorRestartError) {
        onRestart(message);
        return;
      }
      setError(message);
    } finally {
      setPending(false);
    }
  }

  const totp = method === "totp";
  return (
    <View style={{ marginTop: 16 }}>
      <Text style={{ color: tokens.mutedForeground, fontSize: 15, textAlign: "center" }}>
        {totp
          ? t("Open your authenticator app and enter the 6-digit code for {name}.", {
              name: APP_NAME,
            })
          : t("Enter one of your backup codes. Each one works once.")}
      </Text>
      <TextInput
        accessibilityLabel={totp ? t("Authentication code") : t("Backup code")}
        autoCapitalize="none"
        autoComplete={totp ? "one-time-code" : "off"}
        autoCorrect={false}
        autoFocus
        keyboardType={totp ? "number-pad" : "default"}
        maxLength={totp ? 7 : 32}
        placeholder={totp ? t("Authentication code") : t("Backup code")}
        placeholderTextColor={tokens.mutedForeground}
        returnKeyType="go"
        textContentType="oneTimeCode"
        value={code}
        onChangeText={setCode}
        onSubmitEditing={() => void submit()}
        style={{
          marginTop: 20,
          backgroundColor: tokens.muted,
          borderRadius: 13,
          padding: 16,
          color: tokens.foreground,
          fontSize: totp ? 22 : 17,
          letterSpacing: totp ? 6 : 0,
          textAlign: "center",
        }}
      />
      <Pressable
        accessibilityRole="checkbox"
        accessibilityState={{ checked: trustDevice }}
        hitSlop={8}
        onPress={() => setTrustDevice((value) => !value)}
        style={{ flexDirection: "row", alignItems: "center", marginTop: 14 }}
      >
        <View
          style={{
            width: 20,
            height: 20,
            borderRadius: 5,
            borderWidth: 2,
            borderColor: trustDevice ? tokens.foreground : tokens.mutedForeground,
            backgroundColor: trustDevice ? tokens.foreground : "transparent",
            marginRight: 10,
          }}
        />
        <Text style={{ color: tokens.foreground, fontSize: 15 }}>
          {t("Trust this device for 30 days")}
        </Text>
      </Pressable>
      {error ? (
        <Text accessibilityRole="alert" style={{ color: tokens.destructive, marginTop: 12 }}>
          {error}
        </Text>
      ) : null}
      <NativeActionButton
        disabled={pending}
        label={pending ? t("Working…") : t("Verify")}
        onPress={() => void submit()}
        style={{ marginTop: 16 }}
      />
      <Pressable
        accessibilityRole="button"
        hitSlop={8}
        onPress={() => {
          setMethod(totp ? "backup" : "totp");
          setCode("");
          setError(null);
        }}
        style={{ alignSelf: "center", marginTop: 16 }}
      >
        <Text style={{ color: tokens.foreground, fontSize: 14, fontWeight: "600" }}>
          {totp ? t("Use a backup code") : t("Use your authenticator app")}
        </Text>
      </Pressable>
      <Pressable
        accessibilityRole="button"
        hitSlop={8}
        disabled={pending}
        onPress={onCancel}
        style={{ alignSelf: "center", marginTop: 16 }}
      >
        <Text style={{ color: tokens.mutedForeground, fontSize: 14 }}>{t("Back to sign in")}</Text>
      </Pressable>
    </View>
  );
}
