import { Trans, useLingui } from "@lingui/react/macro";
import { ORPCError } from "@orpc/client";
import type { BrandErrorReason, BrandSettings } from "@rakazo/contracts";
import { BRAND_LOGO_MAX_BYTES, BRAND_TEXT_LIMITS } from "@rakazo/core";
import { Button, Field, FieldLabel, Input } from "@rakazo/ui-web";
import { useEffect, useId, useRef, useState } from "react";
import { SuccessPop } from "../components/ai/primitives";
import { setBrand } from "../lib/brand";
import { rpc } from "../lib/rpc";

type TextField = "name" | "shortName" | "tagline";

function brandErrorReason(error: unknown): BrandErrorReason | null {
  if (!(error instanceof ORPCError) || error.code !== "BAD_REQUEST") return null;
  const reason = (error.data as { reason?: unknown } | undefined)?.reason;
  return typeof reason === "string" ? (reason as BrandErrorReason) : null;
}

/** File bytes as base64, without the data-URL prefix. */
function readBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ""));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

/** Settings → Branding: the deployment owner's name, short name, tagline and logo. */
export function BrandingSettingsPanel() {
  const { t } = useLingui();
  const [settings, setSettings] = useState<BrandSettings | null>(null);
  const [text, setText] = useState<Record<TextField, string>>({
    name: "",
    shortName: "",
    tagline: "",
  });
  const [logo, setLogo] = useState<{ file: File; preview: string } | null>(null);
  const [pending, setPending] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const ids = { name: useId(), shortName: useId(), tagline: useId() };

  const reasonText = (reason: BrandErrorReason | null): string => {
    switch (reason) {
      case "name_too_long":
        return t`Use at most 60 characters for the name.`;
      case "shortName_too_long":
        return t`Use at most 60 characters for the short name.`;
      case "tagline_too_long":
        return t`Use at most 140 characters for the tagline.`;
      case "control_characters":
        return t`Use plain text without line breaks.`;
      case "too_large":
        return t`Use an image of 1 MB or less.`;
      case "unsupported_type":
        return t`Use a PNG, JPEG or WebP image.`;
      case "dimensions":
        return t`Use an image between 64 and 4096 pixels on each side.`;
      case "empty":
      case "corrupt":
        return t`This image could not be read.`;
      default:
        return t`Could not save branding`;
    }
  };

  function load(next: BrandSettings) {
    setSettings(next);
    setText({
      name: next.stored.name ?? "",
      shortName: next.stored.shortName ?? "",
      tagline: next.stored.tagline ?? "",
    });
    setBrand(next.brand);
  }

  useEffect(() => {
    let active = true;
    rpc.brand
      .settings()
      .then((next) => {
        if (active) load(next);
      })
      .catch(() => {
        if (active) setError(t`Could not load branding`);
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => () => (logo ? URL.revokeObjectURL(logo.preview) : undefined), [logo]);

  function chooseLogo(file: File | undefined) {
    setSaved(false);
    setError(null);
    if (!file) return;
    if (file.size > BRAND_LOGO_MAX_BYTES) {
      setError(reasonText("too_large"));
      return;
    }
    setLogo({ file, preview: URL.createObjectURL(file) });
  }

  async function save() {
    if (!settings || pending) return;
    setPending(true);
    setSaved(false);
    setError(null);
    try {
      const changed: Partial<Record<TextField, string>> = {};
      for (const field of ["name", "shortName", "tagline"] as const) {
        if (text[field].trim() !== (settings.stored[field] ?? "")) changed[field] = text[field];
      }
      let next = settings;
      if (Object.keys(changed).length) next = await rpc.brand.update(changed);
      if (logo) {
        next = await rpc.brand.uploadLogo({ data: await readBase64(logo.file) });
        setLogo(null);
        if (fileInput.current) fileInput.current.value = "";
      }
      load(next);
      setSaved(true);
    } catch (caught) {
      setError(reasonText(brandErrorReason(caught)));
    } finally {
      setPending(false);
    }
  }

  async function removeLogo() {
    if (pending) return;
    setPending(true);
    setSaved(false);
    setError(null);
    try {
      load(await rpc.brand.removeLogo());
    } catch (caught) {
      setError(reasonText(brandErrorReason(caught)));
    } finally {
      setPending(false);
    }
  }

  const brand = settings?.brand;
  const labels: Record<TextField, string> = {
    name: t`Name`,
    shortName: t`Short name`,
    tagline: t`Tagline`,
  };

  return (
    <div data-testid="branding-settings" className="space-y-5">
      <section className="rounded-xl border border-border px-4 py-4">
        <div className="grid gap-3">
          {(["name", "shortName", "tagline"] as const).map((field) => (
            <Field key={field}>
              <FieldLabel htmlFor={ids[field]}>{labels[field]}</FieldLabel>
              <Input
                id={ids[field]}
                name={`brand-${field}`}
                value={text[field]}
                maxLength={BRAND_TEXT_LIMITS[field]}
                placeholder={brand?.[field]}
                disabled={!settings}
                onChange={(event) => {
                  setSaved(false);
                  setText((current) => ({ ...current, [field]: event.target.value }));
                }}
              />
            </Field>
          ))}
        </div>
      </section>

      <section className="rounded-xl border border-border px-4 py-4">
        <h3 className="text-[15px] font-medium text-foreground">
          <Trans>Logo</Trans>
        </h3>
        <div className="mt-3 flex flex-wrap items-center gap-4">
          {logo || brand ? (
            <img
              data-testid="branding-logo-preview"
              src={logo?.preview ?? brand?.logoUrl}
              alt=""
              className="size-16 rounded-xl border border-border object-contain"
            />
          ) : (
            <div className="size-16 rounded-xl border border-border" />
          )}
          <input
            ref={fileInput}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            className="sr-only"
            data-testid="branding-logo-input"
            aria-label={t`Upload logo`}
            onChange={(event) => chooseLogo(event.target.files?.[0])}
          />
          <Button
            variant="outline"
            className="rounded-full"
            disabled={!settings || pending}
            onClick={() => fileInput.current?.click()}
          >
            <Trans>Upload logo</Trans>
          </Button>
          {brand?.customLogo && !logo ? (
            <Button
              variant="ghost"
              className="rounded-full"
              disabled={pending}
              onClick={() => void removeLogo()}
            >
              <Trans>Remove logo</Trans>
            </Button>
          ) : null}
        </div>
      </section>

      {error ? (
        <p role="alert" className="text-[12.5px] text-destructive">
          {error}
        </p>
      ) : null}
      <div className="flex items-center gap-3">
        <Button
          className="rounded-full"
          disabled={!settings || pending}
          onClick={() => void save()}
        >
          {pending ? <Trans>Saving…</Trans> : <Trans>Save</Trans>}
        </Button>
        {saved ? <SuccessPop label={t`Saved`} /> : null}
      </div>
    </div>
  );
}
