const BROWSER_RESERVED_PORTS = new Set([
  1,
  7,
  9,
  11,
  13,
  15,
  17,
  19,
  20,
  21,
  22,
  23,
  25,
  37,
  42,
  43,
  53,
  69,
  77,
  79,
  87,
  95,
  101,
  102,
  103,
  104,
  109,
  110,
  111,
  113,
  115,
  117,
  119,
  123,
  135,
  137,
  139,
  143,
  161,
  179,
  389,
  427,
  465,
  512,
  513,
  514,
  515,
  526,
  530,
  531,
  532,
  540,
  548,
  554,
  556,
  563,
  587,
  601,
  636,
  989,
  990,
  993,
  995,
  1719,
  1720,
  1723,
  2049,
  3659,
  4045,
  5060,
  5061,
  6000,
  6566,
  6665,
  6666,
  6667,
  6668,
  6669,
  6697,
  10080,
]);

export function isBrowserSafePort(port: number): boolean {
  return Number.isInteger(port) && port > 0 && port < 65_536 && !BROWSER_RESERVED_PORTS.has(port);
}

export function safePreviewPort(value: string, base: number, span: number): number {
  const normalizedSpan = Math.max(1, Math.trunc(span));
  const offset = hashId(value) % normalizedSpan;
  for (let index = 0; index < normalizedSpan; index += 1) {
    const port = base + ((offset + index) % normalizedSpan);
    if (isBrowserSafePort(port)) {
      return port;
    }
  }
  throw new Error(`No browser-safe preview port available in range ${base}-${base + normalizedSpan - 1}`);
}

function hashId(value: string): number {
  return [...value].reduce((sum, char) => sum + char.charCodeAt(0), 0);
}
