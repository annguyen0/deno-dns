// Input validation chung cho Admin API (plan §4.2 api/validators.ts).
// Nhanh, khong khoi tao schema library — ung voi quy mo cua app.

export const MIN_PASSWORD_LENGTH = 6;

/** Password hop le: phai la string, sau trim() du ≥ MIN_PASSWORD_LENGTH. */
export function isValidPassword(value: unknown): value is string {
  return typeof value === "string" &&
    value.trim().length >= MIN_PASSWORD_LENGTH;
}

/** Ep ve string an toan (req.json() co the tra number/boolean/null). */
export function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * Validate mot truong bat buoc la string rong.
 * Tra ve null neu hop le, nguoc lai tra ve message loi (de route tra 400).
 */
export function requiredString(
  value: unknown,
  label: string,
): { ok: true; value: string } | { ok: false; error: string } {
  if (typeof value !== "string" || value.trim().length === 0) {
    return { ok: false, error: `Trường "${label}" là bắt buộc!` };
  }
  return { ok: true, value: value.trim() };
}
