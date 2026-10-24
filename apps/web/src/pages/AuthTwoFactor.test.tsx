// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { authClient } from "../lib/auth";
import { fetchAuthCapabilities } from "../lib/auth-capabilities";
import { AuthPage } from "./Auth";

vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (strings: TemplateStringsArray, ...values: unknown[]) =>
      strings.reduce((text, part, index) => text + part + (values[index] ?? ""), ""),
  }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@lingui/core/macro", () => ({
  t: (strings: TemplateStringsArray, ...values: unknown[]) =>
    strings.reduce((text, part, index) => text + part + (values[index] ?? ""), ""),
}));
vi.mock("@rakazo/ui-web", () => ({
  Button: ({
    children,
    variant: _variant,
    size: _size,
    ...props
  }: React.ComponentProps<"button"> & { variant?: string; size?: string }) => (
    <button {...props}>{children}</button>
  ),
  Checkbox: ({
    checked,
    onCheckedChange,
    ...props
  }: Omit<React.ComponentProps<"input">, "onChange"> & {
    onCheckedChange?: (checked: boolean) => void;
  }) => (
    <input
      type="checkbox"
      checked={checked}
      onChange={(event) => onCheckedChange?.(event.target.checked)}
      {...props}
    />
  ),
  Input: (props: React.ComponentProps<"input">) => <input {...props} />,
  Label: ({ children, htmlFor, ...props }: React.ComponentProps<"label">) => (
    <label htmlFor={htmlFor} {...props}>
      {children}
    </label>
  ),
}));
vi.mock("../lib/auth-capabilities", () => ({ fetchAuthCapabilities: vi.fn() }));
vi.mock("../lib/auth", () => ({
  authClient: {
    signIn: { email: vi.fn(), social: vi.fn() },
    $store: { notify: vi.fn() },
    twoFactor: { verifyTotp: vi.fn(), verifyBackupCode: vi.fn() },
  },
}));
vi.mock("../lib/rpc", () => ({ clearSpaceSelection: vi.fn() }));

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(fetchAuthCapabilities).mockResolvedValue({
    passwordAuth: true,
    sso: null,
    passwordReset: false,
    resetUrl: null,
  });
  vi.mocked(authClient.signIn.email).mockResolvedValue({
    data: { twoFactorRedirect: true, twoFactorMethods: ["totp"] },
    error: null,
  } as never);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

function type(input: Element | null, value: string) {
  if (!(input instanceof HTMLInputElement)) throw new Error("missing input");
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

async function submit() {
  await act(async () => {
    host.querySelector("form")!.requestSubmit();
  });
}

async function signInWithPassword() {
  await act(async () =>
    root.render(
      <MemoryRouter>
        <AuthPage mode="in" />
      </MemoryRouter>,
    ),
  );
  await act(async () => {
    type(host.querySelector('input[name="email"]'), "owner@example.com");
    type(host.querySelector('input[name="password"]'), "owner-password-123");
  });
  await submit();
}

it("asks for the authenticator code after the password, and can trust the device", async () => {
  vi.mocked(authClient.twoFactor.verifyTotp).mockResolvedValue({ data: {}, error: null } as never);
  await signInWithPassword();
  expect(host.textContent).toContain("Enter your code");
  expect(host.querySelector('input[name="password"]')).toBeNull();
  // No session yet, so no session refresh that would remount the page.
  expect(authClient.signIn.email).toHaveBeenCalledWith(
    { email: "owner@example.com", password: "owner-password-123" },
    { disableSignal: true },
  );
  expect(authClient.$store.notify).not.toHaveBeenCalled();
  const code = host.querySelector("#two-factor-code");
  expect(code?.getAttribute("autocomplete")).toBe("one-time-code");
  await act(async () => {
    type(code, "123 456");
    (host.querySelector("#trust-device") as HTMLInputElement).click();
  });
  await submit();
  expect(authClient.twoFactor.verifyTotp).toHaveBeenCalledWith({
    code: "123456",
    trustDevice: true,
  });
  expect(authClient.twoFactor.verifyBackupCode).not.toHaveBeenCalled();
});

it("accepts a backup code instead", async () => {
  vi.mocked(authClient.twoFactor.verifyBackupCode).mockResolvedValue({
    data: {},
    error: null,
  } as never);
  await signInWithPassword();
  const toggle = [...host.querySelectorAll("button")].find((button) =>
    button.textContent?.includes("Use a backup code"),
  );
  await act(async () => toggle!.click());
  expect(host.textContent).toContain("Backup code");
  await act(async () => type(host.querySelector("#two-factor-code"), " AbCdE-12345 "));
  await submit();
  expect(authClient.twoFactor.verifyBackupCode).toHaveBeenCalledWith({
    code: "AbCdE-12345",
    trustDevice: false,
  });
});

it("refreshes the session itself when the password alone signs in", async () => {
  vi.mocked(authClient.signIn.email).mockResolvedValue({
    data: { token: "t", user: { id: "u" } },
    error: null,
  } as never);
  await signInWithPassword();
  expect(authClient.$store.notify).toHaveBeenCalledWith("$sessionSignal");
  expect(host.querySelector("#two-factor-code")).toBeNull();
});

it("shows a wrong code's error and stays on the code step", async () => {
  vi.mocked(authClient.twoFactor.verifyTotp).mockResolvedValue({
    data: null,
    error: { code: "INVALID_CODE", message: "Invalid code", status: 401 },
  } as never);
  await signInWithPassword();
  await act(async () => type(host.querySelector("#two-factor-code"), "000000"));
  await submit();
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("That code didn’t work");
  expect(host.querySelector("#two-factor-code")).not.toBeNull();
});

it("goes back to the password once the pending sign-in is used up", async () => {
  vi.mocked(authClient.twoFactor.verifyTotp).mockResolvedValue({
    data: null,
    error: { code: "TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE", message: "Too many", status: 400 },
  } as never);
  await signInWithPassword();
  await act(async () => type(host.querySelector("#two-factor-code"), "000000"));
  await submit();
  expect(host.querySelector("#two-factor-code")).toBeNull();
  expect(host.querySelector('input[name="password"]')).not.toBeNull();
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("Sign in again");
});
