// Hang so SSRF guard (plan §9: "Abuse sync (SSRF)").
export const BLOCKED_HOSTS = new Set([
  "localhost",
  "metadata",
  "metadata.google.internal",
]);

export const BLOCKED_HOST_SUFFIXES = [".local", ".internal", ".lan"];
