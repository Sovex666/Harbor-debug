const SALT_KEY = "harbor.browse-cache.salt.v1";

// An unavailable persistent salt means there is no stable, private disk key.
export function cacheInstallationSalt(): string | null {
  try {
    const current = localStorage.getItem(SALT_KEY);
    if (current && /^[a-f0-9]{64}$/.test(current)) return current;
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    const salt = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
    localStorage.setItem(SALT_KEY, salt);
    return localStorage.getItem(SALT_KEY) === salt ? salt : null;
  } catch {
    return null;
  }
}
