// @vitest-environment jsdom
import { tokensForAppearance } from "@rakazo/ui-tokens";
import type { ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import SignIn from "../app/sign-in";
import { passwordResetCapabilities, signIn, verifyTwoFactorCode } from "./api";
import type { NativeActionButtonProps } from "./native-controls";
import { TwoFactorRestartError } from "./two-factor";

const route = vi.hoisted(() => ({ mode: "in" }));
const router = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn() }));

vi.mock("expo-router", () => ({
  Redirect: () => null,
  useRouter: () => router,
  useLocalSearchParams: () => route,
  useFocusEffect: () => undefined,
}));
vi.mock("react-native", () => {
  const Container = ({ children }: { children: ReactNode }) => <div>{children}</div>;
  return {
    Platform: { OS: "ios" },
    Keyboard: { dismiss: vi.fn() },
    AccessibilityInfo: { announceForAccessibility: vi.fn() },
    KeyboardAvoidingView: Container,
    TouchableWithoutFeedback: Container,
    View: Container,
    ScrollView: Container,
    Text: ({ children }: { children: ReactNode }) => <span>{children}</span>,
    TextInput: ({
      placeholder,
      secureTextEntry,
      value,
      onChangeText,
    }: {
      placeholder: string;
      secureTextEntry?: boolean;
      value?: string;
      onChangeText?: (text: string) => void;
    }) => (
      <input
        aria-label={placeholder}
        type={secureTextEntry ? "password" : "text"}
        value={value ?? ""}
        onChange={(event) => onChangeText?.(event.currentTarget.value)}
      />
    ),
    Pressable: ({
      children,
      onPress,
      accessibilityRole,
      accessibilityState,
    }: {
      children: ReactNode;
      onPress: () => void;
      accessibilityRole?: string;
      accessibilityState?: { checked?: boolean };
    }) =>
      accessibilityRole === "checkbox" ? (
        <label>
          <input
            type="checkbox"
            checked={accessibilityState?.checked ?? false}
            onChange={onPress}
          />
          {children}
        </label>
      ) : (
        <button type="button" onClick={onPress}>
          {children}
        </button>
      ),
  };
});
vi.mock("react-native-safe-area-context", () => ({
  SafeAreaView: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("../components/native-action-button", () => ({
  NativeActionButton: ({ label, prominence = "primary", onPress }: NativeActionButtonProps) => (
    <button type="button" data-prominence={prominence} onClick={onPress}>
      {label}
    </button>
  ),
}));
vi.mock("./native", () => ({ useMobileTokens: () => tokensForAppearance("light") }));
vi.mock("./i18n", () => ({
  useI18n: () => ({
    t: (text: string, values?: Record<string, string>) =>
      text.replace(/\{(\w+)\}/g, (_, key: string) => values?.[key] ?? key),
  }),
}));
vi.mock("./api", () => ({
  currentApiBase: () => "https://example.invalid",
  displayApiHost: () => "example.invalid",
  usesCustomApiBase: () => false,
  loadSessionToken: vi.fn().mockResolvedValue(null),
  passwordResetCapabilities: vi.fn(),
  requestPasswordReset: vi.fn(),
  rpc: vi.fn(),
  signIn: vi.fn(),
  signUp: vi.fn(),
  verifyTwoFactorCode: vi.fn(),
  clearTwoFactorChallenge: vi.fn(),
}));
vi.mock("./sso", () => ({ continueWithSso: vi.fn() }));
vi.mock("./user-error", () => ({ credentialIssueText: vi.fn(), errorText: vi.fn() }));

const capabilities = {
  passwordAuth: true,
  passwordReset: true,
  resetUrl: "https://example.invalid/reset-password",
  sso: { name: "Example", availability: "available" as const },
};
let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  route.mode = "in";
  router.replace.mockReset();
  vi.mocked(signIn).mockReset();
  vi.mocked(verifyTwoFactorCode).mockReset();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.mocked(passwordResetCapabilities).mockResolvedValue(capabilities);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
async function render() {
  await act(async () => root.render(<SignIn />));
}
function ssoButtons() {
  return [...host.querySelectorAll("button")].filter(
    (button) => button.textContent === "Continue with Example",
  );
}
function expectBefore(first: Element, second: Element) {
  expect(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
}

it.each(["in", "up"])(
  "places a single quiet SSO action below the password form in %s mode",
  async (mode) => {
    route.mode = mode;
    await render();
    const email = host.querySelector('input[aria-label="Email"]')!;
    const password = host.querySelector('input[type="password"]')!;
    const submit = host.querySelector('button[data-prominence="primary"]')!;
    const buttons = ssoButtons();
    expect(buttons).toHaveLength(1);
    const sso = buttons[0]!;
    const prompt = [...host.querySelectorAll("span")].find(
      (span) =>
        span.textContent ===
        (mode === "in" ? "Don’t have an account?" : "Already have an account?"),
    )!;
    expect(submit.textContent).toBe(mode === "in" ? "Sign in" : "Sign up");
    expect(sso.dataset.prominence).toBe("quiet");
    expectBefore(email, password);
    expectBefore(password, submit);
    expectBefore(submit, sso);
    expectBefore(sso, prompt);
  },
);

it.each(["in", "up"])(
  "shows one primary SSO action without credentials in SSO-only %s mode",
  async (mode) => {
    route.mode = mode;
    vi.mocked(passwordResetCapabilities).mockResolvedValue({
      ...capabilities,
      passwordAuth: false,
    });
    await render();
    expect(ssoButtons()).toHaveLength(1);
    expect(ssoButtons()[0]!.dataset.prominence).toBe("primary");
    expect(host.querySelector('button[data-prominence="quiet"]')).toBeNull();
    expect(host.querySelector("input")).toBeNull();
  },
);

it("hides SSO when switching to password recovery", async () => {
  await render();
  const forgot = [...host.querySelectorAll("button")].find(
    (button) => button.textContent === "Forgot password?",
  )!;
  act(() => forgot.click());
  expect(ssoButtons()).toHaveLength(0);
  expect(host.querySelector('input[type="password"]')).toBeNull();
  expect(host.querySelector('button[data-prominence="primary"]')?.textContent).toBe(
    "Send reset link",
  );
});

function type(input: Element, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
function button(label: string) {
  return [...host.querySelectorAll("button")].find((node) => node.textContent === label);
}
async function press(label: string) {
  const target = button(label);
  expect(target, label).toBeDefined();
  await act(async () => target!.click());
}
async function passwordStep() {
  await render();
  type(host.querySelector('input[aria-label="Email"]')!, "owner@example.com");
  type(host.querySelector('input[type="password"]')!, "correct horse battery");
  await press("Sign in");
}

it("asks a two-factor account for its code, then signs in with it", async () => {
  vi.mocked(signIn).mockResolvedValue({ verificationRequired: false, twoFactorRequired: true });
  vi.mocked(verifyTwoFactorCode).mockResolvedValue();
  await passwordStep();

  expect(host.textContent).toContain("Two-factor authentication");
  expect(host.querySelector('input[type="password"]')).toBeNull();
  expect(router.replace).not.toHaveBeenCalled();
  type(host.querySelector('input[aria-label="Authentication code"]')!, "123456");
  await press("Verify");

  expect(verifyTwoFactorCode).toHaveBeenCalledWith("123456", {
    method: "totp",
    trustDevice: false,
  });
  expect(router.replace).toHaveBeenCalledWith("/");
});

it("keeps the code step open with the reason after a wrong code", async () => {
  vi.mocked(signIn).mockResolvedValue({ verificationRequired: false, twoFactorRequired: true });
  vi.mocked(verifyTwoFactorCode).mockRejectedValue(
    new Error("That code didn’t work. Check your authenticator app and try again."),
  );
  await passwordStep();
  type(host.querySelector('input[aria-label="Authentication code"]')!, "000000");
  await press("Verify");

  expect(host.textContent).toContain(
    "That code didn’t work. Check your authenticator app and try again.",
  );
  expect(host.querySelector('input[aria-label="Authentication code"]')).not.toBeNull();
  expect(router.replace).not.toHaveBeenCalled();
});

it("returns to the password step with the reason when the pending sign-in is gone", async () => {
  vi.mocked(signIn).mockResolvedValue({ verificationRequired: false, twoFactorRequired: true });
  vi.mocked(verifyTwoFactorCode).mockRejectedValue(
    new TwoFactorRestartError("Too many wrong codes. Two-factor sign-in is locked for 15 minutes."),
  );
  await passwordStep();
  type(host.querySelector('input[aria-label="Authentication code"]')!, "123456");
  await press("Verify");

  expect(host.querySelector('input[aria-label="Authentication code"]')).toBeNull();
  expect(host.querySelector('input[type="password"]')).not.toBeNull();
  expect(host.textContent).toContain(
    "Too many wrong codes. Two-factor sign-in is locked for 15 minutes.",
  );
});

it("accepts a backup code and remembers the device only when asked", async () => {
  vi.mocked(signIn).mockResolvedValue({ verificationRequired: false, twoFactorRequired: true });
  vi.mocked(verifyTwoFactorCode).mockResolvedValue();
  await passwordStep();

  await press("Use a backup code");
  const trust = host.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
  expect(trust.checked).toBe(false);
  await act(async () => trust.click());
  expect(trust.checked).toBe(true);
  type(host.querySelector('input[aria-label="Backup code"]')!, "ab12-cd34");
  await press("Verify");

  expect(verifyTwoFactorCode).toHaveBeenCalledWith("ab12-cd34", {
    method: "backup",
    trustDevice: true,
  });
});

it("signs in without a code step when the server does not ask for one", async () => {
  vi.mocked(signIn).mockResolvedValue({ verificationRequired: false });
  await passwordStep();
  expect(host.textContent).not.toContain("Two-factor authentication");
  expect(router.replace).toHaveBeenCalledWith("/");
});
