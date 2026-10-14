/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_DEFAULT_UI_LOCALE?: string;
  readonly PUBLIC_BRAND_NAME?: string;
  readonly PUBLIC_BRAND_SHORT_NAME?: string;
  readonly PUBLIC_BRAND_TAGLINE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

declare module "*.po" {
  export const messages: Record<string, unknown>;
}
