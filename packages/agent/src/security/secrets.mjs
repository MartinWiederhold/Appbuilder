import keytar from "keytar";

const SERVICE = "flutter-builder";

export async function setSecret(name, value) {
  if (!name || !value) {
    throw new Error("setSecret requires name and value");
  }
  await keytar.setPassword(SERVICE, name, value);
}

export async function getSecret(name) {
  if (!name) {
    throw new Error("getSecret requires name");
  }

  // 1) Secure Store
  const stored = await keytar.getPassword(SERVICE, name);
  if (stored) return stored;

  // 2) ENV fallback
  if (process.env[name]) return process.env[name];

  return null;
}

export async function deleteSecret(name) {
  if (!name) {
    throw new Error("deleteSecret requires name");
  }
  await keytar.deletePassword(SERVICE, name);
}

export async function listSecretNames() {
  const creds = await keytar.findCredentials(SERVICE);
  return creds.map((c) => c.account).sort();
}
