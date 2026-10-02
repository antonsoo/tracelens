import type { Plugin } from "vite";

/** The CSP source that allows one inline script: the SHA-256 of its text. */
async function hashSource(script: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(script));
  return `'sha256-${btoa(String.fromCharCode(...new Uint8Array(digest)))}'`;
}

/**
 * Gives the built page a Content-Security-Policy.
 *
 * The page says nothing you give it leaves your browser. This makes the browser hold it to
 * that: scripts, styles, fonts and workers load from the page's own origin only, and
 * `connect-src 'self'` means no script on the page, not even one injected through a bug in
 * how it renders your file, can send anything to another host. Inline scripts in index.html
 * are allowed by their hash; inline event handlers and `eval` are not allowed at all.
 *
 * `'unsafe-inline'` is for styles only: the page sets `style` attributes on what it renders.
 *
 * Built pages only. The dev server injects scripts and styles of its own.
 */
export function contentSecurityPolicy(additions: Record<string, string[]> = {}): Plugin {
  return {
    name: "content-security-policy",
    apply: "build",
    transformIndexHtml: {
      order: "post",
      async handler(html) {
        const inlineScripts = await Promise.all(
          [...html.matchAll(/<script(?![^>]*\bsrc=)([^>]*)>([\s\S]*?)<\/script>/g)]
            .filter(([, attrs, body]) => !/type="application\/(ld\+)?json"/.test(attrs ?? "") && (body ?? "").trim() !== "")
            .map(([, , body]) => hashSource(body ?? "")),
        );
        const policy: Record<string, string[]> = {
          "default-src": ["'none'"],
          "script-src": ["'self'", ...inlineScripts],
          "style-src": ["'self'", "'unsafe-inline'"],
          "img-src": ["'self'", "data:", "blob:"],
          // data: because the bundler inlines font files of a few kilobytes into the stylesheet.
          "font-src": ["'self'", "data:"],
          "connect-src": ["'self'"],
          "worker-src": ["'self'"],
          "manifest-src": ["'self'"],
          "base-uri": ["'none'"],
          "form-action": ["'none'"],
        };
        for (const [directive, sources] of Object.entries(additions)) {
          policy[directive] = [...(policy[directive] ?? []), ...sources];
        }
        const content = Object.entries(policy)
          .map(([directive, sources]) => `${directive} ${sources.join(" ")}`)
          .join("; ");
        const tag = `<meta http-equiv="Content-Security-Policy" content="${content}" />`;
        const charset = /<meta charset="[^"]*"\s*\/?>/i;
        if (!charset.test(html)) throw new Error("index.html has no <meta charset> to put the policy after");
        // First thing after the charset: a policy only governs what follows it.
        return html.replace(charset, (match) => `${match}\n    ${tag}`);
      },
    },
  };
}
