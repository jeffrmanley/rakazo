import { organizationClient, twoFactorClient } from "better-auth/client/plugins";
import { createAuthClient, type ReactAuthClient } from "better-auth/react";

// The organization plugin's client type resolves to `any`, which would erase every plugin's
// methods from the annotation, so only the two-factor plugin is named here.
export const authClient: ReactAuthClient<{
  plugins: [ReturnType<typeof twoFactorClient>];
}> = createAuthClient({
  plugins: [organizationClient(), twoFactorClient()],
});
