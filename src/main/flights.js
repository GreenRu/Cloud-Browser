'use strict';

const { app, shell } = require('electron');
const fs = require('fs');
const path = require('path');

/**
 * Flights - files on their way down out of the sky.
 *
 * A browser calls these downloads. Stratus calls them flights, because they
 * arrive: one leaves a site and lands somewhere on this computer.
 * `stratus://downloads` still works, and the save dialog still says what
 * everyone else says, so nobody has to learn the word to use the thing.
 *
 * Everything about a live download lives here. The renderer is told what is
 * happening and asks for things to be done; it never holds a `DownloadItem`,
 * and it cannot name a path of its own invention.
 */

/** What a flight looks like once it is only a record. */
function record(item, id, folder) {
  return {
    id,
    name: item.getFilename(),
    url: item.getURL(),
    /** The site it actually came from, which a redirect can make surprising. */
    origin: originOf(item.getURLChain()[0] || item.getURL()),
    path: item.getSavePath() || path.join(folder, item.getFilename()),
    total: item.getTotalBytes(),
    received: item.getReceivedBytes(),
    state: 'flying',
    startedAt: Date.now(),
    /*
     * What it would take to pick this up again after a restart. Electron can
     * resume an interrupted download only if it is handed all of this back.
     */
    resume: {
      urlChain: item.getURLChain(),
      eTag: item.getETag(),
      lastModified: item.getLastModifiedTime(),
      startTime: item.getStartTime(),
      mime: item.getMimeType()
    }
  };
}

function originOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

class Flights {
  /**
   * @param {import('./store').Store} store
   * @param {() => void} onChange  called whenever anything a window draws changed
   */
  constructor(store, onChange) {
    this.store = store;
    this.onChange = onChange || (() => {});
    /** Live downloads, by our id. The renderer never sees these. */
    this.items = new Map();
    /** The last time each one was reported, so a fast file does not flood. */
    this.reported = new Map();
  }

  /** Where files land. The system's own Downloads folder unless told otherwise. */
  get folder() {
    const chosen = this.store.get('downloadFolder');
    if (chosen && typeof chosen === 'string') {
      try {
        fs.mkdirSync(chosen, { recursive: true });
        return chosen;
      } catch {
        // A folder that has gone away should not stop a download.
      }
    }
    return app.getPath('downloads');
  }

  get list() {
    const kept = this.store.get('flights');
    return Array.isArray(kept) ? kept : [];
  }

  set list(next) {
    this.store.set('flights', next.slice(0, 200));
  }

  _update(id, patch) {
    const next = this.list.map((f) => (f.id === id ? { ...f, ...patch } : f));
    this.list = next;
    return next.find((f) => f.id === id);
  }

  /**
   * A file has started on its way.
   *
   * Called from `will-download`. The save path is settled here so nothing is
   * ever written somewhere the person did not choose - and so the record knows
   * where the file will be before it is there.
   */
  take(item) {
    const id = `fl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    const folder = this.folder;

    // A name already in use gets a number rather than overwriting somebody's file.
    const target = freeName(path.join(folder, item.getFilename()));
    item.setSavePath(target);

    const flight = record(item, id, folder);
    flight.path = target;
    this.list = [flight, ...this.list];
    this.items.set(id, item);

    item.on('updated', (_event, state) => {
      const patch = {
        received: item.getReceivedBytes(),
        total: item.getTotalBytes(),
        state: state === 'interrupted' ? 'stalled' : (item.isPaused() ? 'held' : 'flying')
      };
      // Twice a second is enough to look live and not enough to cost anything.
      const last = this.reported.get(id) || 0;
      if (Date.now() - last < 400 && patch.state === 'flying') return;
      this.reported.set(id, Date.now());
      this._update(id, patch);
      this.onChange();
    });

    item.once('done', (_event, state) => {
      this.items.delete(id);
      this.reported.delete(id);
      this._update(id, {
        state: state === 'completed' ? 'landed' : (state === 'cancelled' ? 'called off' : 'lost'),
        received: item.getReceivedBytes(),
        total: item.getTotalBytes(),
        finishedAt: Date.now()
      });
      this.onChange();
    });

    this.onChange();
    return this.list.find((f) => f.id === id);
  }

  /** What the interface draws: the record, plus how fast the live ones are going. */
  state() {
    const now = Date.now();
    return {
      flights: this.list.map((f) => {
        if (f.state !== 'flying' && f.state !== 'held') return f;
        const seconds = Math.max(0.001, (now - f.startedAt) / 1000);
        const speed = f.received / seconds;
        return {
          ...f,
          speed,
          // Only worth showing when the size is known; plenty of servers do not say.
          remaining: f.total > 0 && speed > 0 ? (f.total - f.received) / speed : null
        };
      }),
      folder: this.folder,
      /** One number for the taskbar: everything still in the air, together. */
      progress: this.overall()
    };
  }

  /** How far along everything in the air is, as one fraction, or -1 for nothing. */
  overall() {
    const flying = this.list.filter((f) => f.state === 'flying' || f.state === 'held');
    if (!flying.length) return -1;
    const total = flying.reduce((sum, f) => sum + (f.total > 0 ? f.total : 0), 0);
    const received = flying.reduce((sum, f) => sum + f.received, 0);
    // A download of unknown size cannot be measured, so the bar just waits.
    if (total <= 0) return 2;   // Electron reads 2 as an indeterminate bar
    return Math.min(1, received / total);
  }

  hold(id) {
    const item = this.items.get(id);
    if (!item || item.isPaused()) return false;
    item.pause();
    this._update(id, { state: 'held' });
    this.onChange();
    return true;
  }

  carryOn(id) {
    const item = this.items.get(id);
    if (!item || !item.canResume()) return false;
    item.resume();
    this._update(id, { state: 'flying' });
    this.onChange();
    return true;
  }

  callOff(id) {
    const item = this.items.get(id);
    if (!item) return false;
    item.cancel();
    return true;
  }

  /**
   * Send it again.
   *
   * One that stalled part way is picked up where it stopped, which is the whole
   * reason all that resume information is kept. One that was called off or lost
   * outright starts over.
   */
  again(id, session) {
    const flight = this.list.find((f) => f.id === id);
    if (!flight || this.items.has(id)) return false;

    const partial = flight.state === 'stalled' && flight.received > 0 &&
      fs.existsSync(flight.path);

    if (partial && flight.resume && Array.isArray(flight.resume.urlChain)) {
      session.createInterruptedDownload({
        path: flight.path,
        urlChain: flight.resume.urlChain,
        offset: flight.received,
        length: flight.total,
        lastModified: flight.resume.lastModified,
        eTag: flight.resume.eTag,
        startTime: flight.resume.startTime
      });
      return true;
    }

    session.downloadURL(flight.url);
    return true;
  }

  /** Take one off the list. The file itself is left where it is. */
  forget(id) {
    this.list = this.list.filter((f) => f.id !== id);
    this.onChange();
    return true;
  }

  /** Everything that has finished, one way or another. */
  clearFinished() {
    this.list = this.list.filter((f) => f.state === 'flying' || f.state === 'held');
    this.onChange();
    return true;
  }

  /** Show a landed file where it lives. */
  reveal(id) {
    const flight = this.list.find((f) => f.id === id);
    if (!flight || !flight.path) return false;
    shell.showItemInFolder(flight.path);
    return true;
  }

  /** Open a landed file with whatever the system opens it with. */
  open(id) {
    const flight = this.list.find((f) => f.id === id);
    if (!flight || flight.state !== 'landed') return false;
    shell.openPath(flight.path);
    return true;
  }

  /**
   * Anything that was in the air when the browser last shut is not any more.
   *
   * Called at startup. A flight left saying "flying" would be counted on the
   * toolbar for a download nothing is doing, and its progress would never move.
   */
  groundEverything() {
    let touched = false;
    const next = this.list.map((f) => {
      if (f.state !== 'flying' && f.state !== 'held') return f;
      touched = true;
      return { ...f, state: 'stalled' };
    });
    if (touched) this.list = next;
  }
}

/** `notes.txt`, then `notes (2).txt`, and so on. Nobody's file is overwritten. */
function freeName(wanted) {
  if (!fs.existsSync(wanted)) return wanted;
  const dir = path.dirname(wanted);
  const ext = path.extname(wanted);
  const base = path.basename(wanted, ext);
  for (let n = 2; n < 1000; n++) {
    const candidate = path.join(dir, `${base} (${n})${ext}`);
    if (!fs.existsSync(candidate)) return candidate;
  }
  return wanted;
}

module.exports = { Flights, freeName, originOf };
