'use strict';

const { app, safeStorage } = require('electron');
const fs = require('fs');
const path = require('path');

/**
 * Saved payment cards.
 *
 * Built on the same rule as the login vault: every secret is encrypted with
 * Electron's safeStorage, which delegates to the OS keystore, and if the
 * platform cannot encrypt then saving is refused outright rather than falling
 * back to plaintext. A card store that quietly isn't one is worse than none.
 *
 * Only the last four digits and the expiry are kept in the clear, because those
 * are what a list has to show. The number and the security code are ciphertext.
 *
 * ---------------------------------------------------------------------------
 * The security code
 * ---------------------------------------------------------------------------
 *
 * Keeping the code on the back of the card is off by default, and is the one
 * setting here with a memory.
 *
 * If it is ever switched off, every code held is destroyed at that moment - not
 * hidden, destroyed - and the time is written down. Switching it back on does
 * not bring them back: the next time each card is used the code has to be typed
 * again, and only then is it kept once more.
 *
 * That is what `cvvDisabledAt` is for. A code is only ever offered when it was
 * saved *after* the last time the setting was off, so even a code that somehow
 * outlived the wipe - an older file, a restored profile, a copy made while the
 * setting was on - is not offered either. The rule is enforced by the timestamp
 * rather than only by the deletion, because deletion alone can be undone by a
 * backup and a timestamp cannot.
 */
class CardWallet {
  constructor(store, fileName = 'cards.json') {
    this.store = store;
    this.file = path.join(app.getPath('userData'), fileName);
    this.data = this._read();
  }

  get available() {
    return safeStorage.isEncryptionAvailable();
  }

  /** Whether codes are being kept at all, right now. */
  get keepsCvv() {
    return this.store.get('saveCardCvv') === true;
  }

  /** When the setting was last switched off. Zero means it never has been. */
  get disabledAt() {
    const at = Number(this.store.get('cvvDisabledAt'));
    return Number.isFinite(at) ? at : 0;
  }

  _read() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      return { cards: Array.isArray(parsed.cards) ? parsed.cards : [] };
    } catch {
      return { cards: [] };
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
      console.error('[cards] failed to persist wallet:', err.message);
    }
  }

  _encrypt(text) {
    return safeStorage.encryptString(String(text)).toString('base64');
  }

  _decrypt(secret) {
    try {
      return safeStorage.decryptString(Buffer.from(secret, 'base64'));
    } catch {
      return null;
    }
  }

  // --- what a card is --------------------------------------------------------

  /** Digits only. Cards are typed with spaces and dashes in them. */
  static digitsOf(number) {
    return String(number || '').replace(/\D/g, '');
  }

  /** Luhn, which catches a mistyped digit rather than proving anything. */
  static looksLikeCard(number) {
    const digits = CardWallet.digitsOf(number);
    if (digits.length < 12 || digits.length > 19) return false;

    let sum = 0;
    let double = false;
    for (let i = digits.length - 1; i >= 0; i--) {
      let value = Number(digits[i]);
      if (double) {
        value *= 2;
        if (value > 9) value -= 9;
      }
      sum += value;
      double = !double;
    }
    return sum % 10 === 0;
  }

  /** The network, from the number's own shape. Only for showing a name. */
  static brandOf(number) {
    const digits = CardWallet.digitsOf(number);
    if (/^4/.test(digits)) return 'Visa';
    if (/^(5[1-5]|2[2-7])/.test(digits)) return 'Mastercard';
    if (/^3[47]/.test(digits)) return 'American Express';
    if (/^(6011|65|64[4-9])/.test(digits)) return 'Discover';
    if (/^3(0[0-5]|[68])/.test(digits)) return 'Diners Club';
    if (/^35/.test(digits)) return 'JCB';
    return 'Card';
  }

  static expired({ expMonth, expYear }) {
    const month = Number(expMonth);
    const year = Number(expYear);
    if (!month || !year) return false;
    const now = new Date();
    return year < now.getFullYear() ||
      (year === now.getFullYear() && month < now.getMonth() + 1);
  }

  // --- keeping them ----------------------------------------------------------

  /**
   * Save a card. The code is only kept if the setting is on *and* one was
   * given; a card saved without one is perfectly usable, it just asks.
   */
  save({ number, holder, expMonth, expYear, cvv, label }) {
    if (!this.available) return { ok: false, reason: 'no-keystore' };

    const digits = CardWallet.digitsOf(number);
    if (!CardWallet.looksLikeCard(digits)) return { ok: false, reason: 'not-a-card' };

    const month = Number(expMonth);
    const year = Number(expYear);
    if (!(month >= 1 && month <= 12)) return { ok: false, reason: 'bad-expiry' };
    if (!(year >= 2000 && year <= 2100)) return { ok: false, reason: 'bad-expiry' };

    const keepCode = this.keepsCvv && /^[0-9]{3,4}$/.test(String(cvv || ''));

    const card = {
      id: `card-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      label: String(label || '').slice(0, 40),
      brand: CardWallet.brandOf(digits),
      last4: digits.slice(-4),
      holder: String(holder || '').slice(0, 60),
      expMonth: month,
      expYear: year,
      number: this._encrypt(digits),
      cvv: keepCode ? this._encrypt(String(cvv)) : null,
      // When the code was kept, which is what the rule below is measured against.
      cvvSavedAt: keepCode ? Date.now() : 0,
      addedAt: Date.now()
    };

    // The same card twice is one card.
    this.data.cards = this.data.cards.filter(
      (c) => !(c.last4 === card.last4 && c.expMonth === month && c.expYear === year)
    );
    this.data.cards.unshift(card);
    this._write();

    return { ok: true, id: card.id, keptCvv: keepCode };
  }

  /** Everything a list can show. No number, no code, ever. */
  list() {
    return this.data.cards.map((card) => ({
      id: card.id,
      label: card.label,
      brand: card.brand,
      last4: card.last4,
      holder: card.holder,
      expMonth: card.expMonth,
      expYear: card.expYear,
      addedAt: card.addedAt,
      expired: CardWallet.expired(card),
      // Whether this one could fill its own code, or will have to ask.
      hasCvv: this.cvvUsable(card)
    }));
  }

  /**
   * Whether a card's stored code may be used.
   *
   * Three things have to hold: the setting is on now, this card actually has a
   * code, and that code was saved since the last time the setting was off.
   * The last is the whole point - a code that predates a switch-off is not
   * offered even if the file still contains it.
   */
  cvvUsable(card) {
    if (!card || !card.cvv) return false;
    if (!this.keepsCvv) return false;
    return Number(card.cvvSavedAt || 0) > this.disabledAt;
  }

  /** The full number, for showing the owner on request. */
  reveal(id) {
    const card = this.data.cards.find((c) => c.id === id);
    return card ? this._decrypt(card.number) : null;
  }

  /**
   * What a checkout form should be given.
   *
   * The code comes back only when the rule above allows it. Otherwise the card
   * still fills - number, name, expiry - and `needsCvv` says the person has to
   * type the code themselves.
   */
  forFilling(id) {
    const card = this.data.cards.find((c) => c.id === id);
    if (!card) return null;

    const usable = this.cvvUsable(card);
    return {
      id: card.id,
      brand: card.brand,
      last4: card.last4,
      number: this._decrypt(card.number),
      holder: card.holder,
      expMonth: card.expMonth,
      expYear: card.expYear,
      cvv: usable ? this._decrypt(card.cvv) : null,
      needsCvv: !usable
    };
  }

  /**
   * Keep a code that was just typed, now that it has been.
   *
   * This is how a card gets its code back after the setting was off for a
   * while: it is typed once, and from then on it is offered again.
   */
  rememberCvv(id, cvv) {
    if (!this.available || !this.keepsCvv) return false;
    if (!/^[0-9]{3,4}$/.test(String(cvv || ''))) return false;

    const card = this.data.cards.find((c) => c.id === id);
    if (!card) return false;

    card.cvv = this._encrypt(String(cvv));
    card.cvvSavedAt = Date.now();
    this._write();
    return true;
  }

  /**
   * Switch the keeping of codes on or off.
   *
   * Switching off destroys every code held, right then, and writes down when.
   * Switching on keeps nothing that was there before - each card asks once more
   * and is answered before it is trusted again.
   */
  setKeepCvv(on) {
    const wanted = Boolean(on);
    const was = this.keepsCvv;
    this.store.set('saveCardCvv', wanted);

    if (!wanted && was !== false) {
      this.store.set('cvvDisabledAt', Date.now());
      this.forgetAllCvv();
    }
    return wanted;
  }

  /** Destroy every stored code, leaving the cards themselves alone. */
  forgetAllCvv() {
    let gone = 0;
    for (const card of this.data.cards) {
      if (card.cvv) gone += 1;
      card.cvv = null;
      card.cvvSavedAt = 0;
    }
    if (gone) this._write();
    return gone;
  }

  remove(id) {
    const before = this.data.cards.length;
    this.data.cards = this.data.cards.filter((c) => c.id !== id);
    if (this.data.cards.length !== before) this._write();
    return before - this.data.cards.length;
  }

  clear() {
    this.data.cards = [];
    this._write();
  }
}

module.exports = { CardWallet };
