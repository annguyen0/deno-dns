// Hop hop domain → suffix candidates (tim hieu ung "giong hinh hieu cu").

export function cleanDomain(raw: string): string {
  return raw.toLowerCase().trim().replace(/\.$/, "");
}

/** Doc = "a.b.c" tra ra ["a.b.c", "b.c"] (giong hinh hieu cu: khong match label don). */
export function suffixCandidates(domain: string): string[] {
  const clean = cleanDomain(domain);
  if (!clean) return [];
  const parts = clean.split(".");
  const out: string[] = [];
  for (let i = 0; i < parts.length - 1; i++) {
    out.push(parts.slice(i).join("."));
  }
  return out;
}
