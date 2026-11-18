// Google Search Suggestions (`groundingMetadata.searchEntryPoint.renderedContent`) — display rules
// (docs/API-NOTES.md §2): shown exactly as provided, next to its grounded answer, at the answer's width,
// adapting to light/dark by itself; a tap goes straight to the Google results page (new tab, no
// interstitial). We embed it in a shadow root so the page's CSS can't restyle it and its CSS can't leak out.
// Defence in depth only removes things that can't affect how it looks: scripts, frames, inline event
// handlers and non-http(s) links.

const BLOCKED_TAGS = new Set(["SCRIPT", "IFRAME", "OBJECT", "EMBED", "BASE", "META", "LINK", "FORM"]);

/** Parses the snippet into an inert fragment with anything executable removed. */
export function sanitizedEntryPoint(html: string, doc: Document = document): DocumentFragment {
  const template = doc.createElement("template");
  template.innerHTML = html;
  const walker = doc.createTreeWalker(template.content, NodeFilter.SHOW_ELEMENT);
  const remove: Element[] = [];
  for (let node = walker.nextNode() as Element | null; node; node = walker.nextNode() as Element | null) {
    if (BLOCKED_TAGS.has(node.tagName.toUpperCase())) { remove.push(node); continue; }
    for (const attr of Array.from(node.attributes)) {
      const name = attr.name.toLowerCase();
      const value = attr.value.trim().toLowerCase();
      if (name.startsWith("on")) node.removeAttribute(attr.name);
      else if ((name === "href" || name === "src" || name === "xlink:href" || name === "action") && !/^(https?:|#|\/\/)/.test(value) && value !== "") node.removeAttribute(attr.name);
    }
    if (node.tagName.toUpperCase() === "A") {
      node.setAttribute("target", "_blank");
      node.setAttribute("rel", "noopener noreferrer");
    }
  }
  for (const el of remove) el.remove();
  return template.content;
}

/** Renders the snippet into `host`'s (open) shadow root, replacing what was there. */
export function mountEntryPoint(host: HTMLElement, html: string): void {
  const root = host.shadowRoot ?? host.attachShadow({ mode: "open" });
  root.replaceChildren(sanitizedEntryPoint(html, host.ownerDocument));
}
