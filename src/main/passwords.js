'use strict';

const { app, safeStorage } = require('electron');
const fs = require('fs');
const path = require('path');

/**
 * Saved logins.
 *
 * Every secret is encrypted with Electron's safeStorage, which delegates to the
 * OS keystore (DPAPI on Windows, Keychain on macOS, libsecret/kwallet on
 * Linux). The file on disk therefore holds ciphertext that is bound to the
 * logged-in OS user.
 *
 * If the platform cannot encrypt, saving is refused outright - a plaintext
 * fallback would be worse than not offering the feature, because the user
 * would believe their passwords were protected.
 */
class PasswordVault {
  constructor(fileName = 'logins.json') {
    this.file = path.join(app.getPath('userData'), fileName);
    this.data = this._read();
  }

  get available() {
    return safeStorage.isEncryptionAvailable();
  }

  _read() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      return {
        entries: Array.isArray(parsed.entries) ? parsed.entries : [],
        never: Array.isArray(parsed.never) ? parsed.never : []
      };
    } catch {
      return { entries: [], never: [] };
    }
  }

  _write() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2), {
        encoding: 'utf8',
        mode: 0o600
      });
    } catch (err) {
      console.error('[passwords] failed to persist vault:', err.message);
    }
  }

  /** Normalise to scheme + host + port; credentials never cross an origin. */
  static originOf(url) {
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
      return parsed.origin;
    } catch {
      return null;
    }
  }

  isBlocked(origin) {
    return this.data.never.includes(origin);
  }

  block(origin) {
    if (!origin || this.isBlocked(origin)) return;
    this.data.never.push(origin);
    this._write();
  }

  unblock(origin) {
    this.data.never = this.data.never.filter((o) => o !== origin);
    this._write();
  }

  /** Entry list for the settings page - never includes secrets. */
  list() {
    return this.data.entries
      .map(({ id, origin, username, updatedAt }) => ({ id, origin, username, updatedAt }))
      .sort((a, b) => a.origin.localeCompare(b.origin) || a.username.localeCompare(b.username));
  }

  /** Does a stored login differ from what was just submitted? */
  status(origin, username, password) {
    const existing = this.data.entries.find((e) => e.origin === origin && e.username === username);
    if (!existing) return 'new';
    return this.reveal(existing.id) === password ? 'unchanged' : 'changed';
  }

  save({ origin, username, password }) {
    if (!origin || !password) return null;
    if (!this.available) throw new Error('OS encryption is unavailable');

    const secret = safeStorage.encryptString(password).toString('base64');
    const existing = this.data.entries.find((e) => e.origin === origin && e.username === username);

    if (existing) {
      existing.secret = secret;
      existing.updatedAt = Date.now();
    } else {
      this.data.entries.push({
        id: `pw-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        origin,
        username: username || '',
        secret,
        updatedAt: Date.now()
      });
    }

    this.unblock(origin);
    this._write();
    return true;
  }

  /** Credentials for one origin, secrets decrypted. Used only for autofill. */
  forOrigin(origin) {
    if (!origin || !this.available) return [];
    return this.data.entries
      .filter((e) => e.origin === origin)
      .map((e) => ({ id: e.id, username: e.username, password: this._decrypt(e.secret) }))
      .filter((e) => e.password !== null);
  }

  reveal(id) {
    const entry = this.data.entries.find((e) => e.id === id);
    return entry ? this._decrypt(entry.secret) : null;
  }

  _decrypt(secret) {
    try {
      return safeStorage.decryptString(Buffer.from(secret, 'base64'));
    } catch {
      // Written by a different OS user, or the keystore was reset.
      return null;
    }
  }

  remove(id) {
    const before = this.data.entries.length;
    this.data.entries = this.data.entries.filter((e) => e.id !== id);
    if (this.data.entries.length !== before) this._write();
  }

  clear() {
    this.data.entries = [];
    this._write();
  }
}

module.exports = { PasswordVault };
