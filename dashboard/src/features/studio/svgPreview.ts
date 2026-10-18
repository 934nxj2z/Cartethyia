const MAX_SVG_PREVIEW_LENGTH = 100_000;

/** Wraps a bounded SVG document in a restrictive HTML document for a sandboxed frame. */
export function createSvgPreviewDocument(source: string): string | undefined {
  const trimmed = source.trim();
  if (
    trimmed.length === 0 ||
    trimmed.length > MAX_SVG_PREVIEW_LENGTH ||
    /<!doctype|<!entity/i.test(trimmed) ||
    !/^(?:<\?xml[^>]*>\s*)?<svg(?:\s|>)/i.test(trimmed) ||
    !/<\/svg>\s*$/i.test(trimmed)
  ) {
    return undefined;
  }
  const policy = "default-src 'none'; script-src 'none'; object-src 'none'; connect-src 'none'; img-src data:; media-src data:; font-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'";
  const fitArtwork = "html,body{box-sizing:border-box;width:100%;height:100%;margin:0;overflow:hidden;display:grid;place-items:center}svg{display:block;max-width:100%;max-height:100%;width:auto;height:auto;object-fit:contain;overflow:visible}";
  return `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${policy}"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${fitArtwork}</style></head><body>${trimmed}</body></html>`;
}
