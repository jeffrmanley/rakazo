import { useEffect, useMemo, useRef, useState } from "react";

const PREVIEW_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; form-action 'none'; base-uri 'none'";

/**
 * The frame (apps/web/public/html-preview.html) that renders the preview in a nested sandboxed
 * srcdoc iframe. A URL, not a srcdoc shell: srcdoc documents inherit the app's CSP, whose
 * `script-src 'self'` would block the shell's script and the artifact's own scripts. The frame
 * carries its own policy (`frame-src about:` lets it load the srcdoc and rejects navigations).
 */
export const HTML_PREVIEW_FRAME_URL = "/html-preview.html";
export const HTML_PREVIEW_MESSAGE = "rakazo:html-preview";

const PREVIEW_GUARD = `<script>
document.addEventListener("click", (event) => {
  const target = event.target;
  const link = target instanceof Element ? target.closest("a[href]") : null;
  if (!link) return;
  const href = link.getAttribute("href") ?? "";
  event.preventDefault();
  if (href.startsWith("#")) location.hash = href;
}, true);
document.addEventListener("submit", (event) => event.preventDefault(), true);
</script>`;

function withPreviewDocument(html: string): string {
  const meta = `<meta http-equiv="Content-Security-Policy" content="${PREVIEW_CSP}">`;
  const referrer = `<meta name="referrer" content="no-referrer">`;
  return `${meta}${referrer}${PREVIEW_GUARD}${html}`;
}

export function SandboxedHtmlViewer({ html, title }: { html: string; title: string }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [loads, setLoads] = useState(0);
  const previewDocument = useMemo(() => withPreviewDocument(html), [html]);

  useEffect(() => {
    if (loads === 0) return;
    // The frame is sandboxed without allow-same-origin, so its origin is opaque: "*" is the
    // only target that reaches it. It accepts messages from its parent only.
    frame.current?.contentWindow?.postMessage(
      { type: HTML_PREVIEW_MESSAGE, html: previewDocument },
      "*",
    );
  }, [loads, previewDocument]);

  return (
    <iframe
      ref={frame}
      title={title}
      src={HTML_PREVIEW_FRAME_URL}
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      onLoad={() => setLoads((count) => count + 1)}
      className="h-full w-full border-0 bg-white"
    />
  );
}
