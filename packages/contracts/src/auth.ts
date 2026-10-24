import { z } from "zod";

export const authCapabilitiesSchema = z.object({
  sso: z
    .object({
      name: z.string().min(1),
      availability: z.enum(["available", "unavailable", "checking"]),
    })
    .nullable(),
  passwordAuth: z.boolean(),
  passwordReset: z.boolean(),
  resetUrl: z.string().url().nullable(),
  billing: z.boolean().optional(),
});
export type AuthCapabilities = z.infer<typeof authCapabilitiesSchema>;

export const accountSecuritySchema = z.object({
  hasPassword: z.boolean(),
  // Older servers omit this field; clients treat omission as enabled.
  passwordChangeEnabled: z.boolean().optional(),
  freshOidcAuth: z.boolean(),
  ssoLinked: z.boolean(),
  emailDeletion: z.boolean(),
  sso: z.object({ name: z.string().min(1) }).nullable(),
});
export type AccountSecurity = z.infer<typeof accountSecuritySchema>;

/** The signed-in account's two-factor state: `GET /api/auth/two-factor-policy`. */
export const twoFactorPolicySchema = z.object({
  enabled: z.boolean(),
  required: z.boolean(),
  /** Unenrolled but required: the deployment owner sees a banner, anyone else the enrolment screen. */
  enforcement: z.enum(["none", "banner", "enrol"]),
  /** False for an account without a password; two-factor guards password sign-in only. */
  available: z.boolean(),
});
export type TwoFactorPolicyView = z.infer<typeof twoFactorPolicySchema>;

/** Only a complete pre-SSO shape may opt into password-only compatibility. */
export const legacyAuthCapabilitiesSchema = authCapabilitiesSchema
  .omit({ sso: true, passwordAuth: true })
  .strict()
  .transform((value) => ({ ...value, passwordAuth: true, sso: null }));

/** Pre-SSO servers only had credential accounts and password-protected deletion. */
export const legacyAccountSecurity: AccountSecurity = {
  hasPassword: true,
  passwordChangeEnabled: true,
  freshOidcAuth: false,
  ssoLinked: false,
  emailDeletion: false,
  sso: null,
};
