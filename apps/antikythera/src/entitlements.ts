import { readFileSync } from 'node:fs';
import { parseEntitlements, type Entitlements } from '@apeiron/logos';

/** Reads and validates the entitlements file. Throws, naming the file, when it is missing or invalid: the blotter must not start without it. */
export function loadEntitlements(path: string): Entitlements {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    throw new Error(`Cannot read the entitlements file ${path}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new Error(`The entitlements file ${path} is not valid JSON`, { cause: error });
  }
  const parsed = parseEntitlements(json);
  if (!parsed.ok) throw new Error(`The entitlements file ${path} is invalid: ${parsed.error}`);
  return parsed.value;
}
