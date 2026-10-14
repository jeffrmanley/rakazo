import type { ReactNode } from "react";
import { useBrand } from "../lib/brand";

/**
 * The deployment owner's uploaded logo, or `children` (the product mark)
 * when there is none, so an unbranded deployment looks as upstream does.
 */
export function BrandLogo({ className, children }: { className?: string; children?: ReactNode }) {
  const brand = useBrand();
  if (!brand.customLogo) return children ?? null;
  return (
    <img
      data-testid="brand-logo"
      src={brand.logoUrl}
      alt={brand.name}
      className={`shrink-0 rounded-xl object-contain ${className ?? ""}`}
    />
  );
}
