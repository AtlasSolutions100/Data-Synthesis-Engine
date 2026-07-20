export const MAX_EXTRACT_TEXT_LENGTH = 20000;

export function extractTextTooLargeMessage(length: number): string {
  return `That text is too large to import (${length.toLocaleString()} characters). Please paste at most ${MAX_EXTRACT_TEXT_LENGTH.toLocaleString()} characters at a time.`;
}
