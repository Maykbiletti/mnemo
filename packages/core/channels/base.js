"use strict";
/**
 * BaseChannel — abstract interface every channel adapter implements.
 * Implementations live in channels/<name>.js. The registry exports a map.
 */
class BaseChannel {
  constructor(name) {
    this.name = name;
  }
  /** @returns {boolean} whether this channel is configured + reachable */
  isEnabled() { return false; }
  /** Send a text message. Returns provider message_id on success. */
  async send(to, text, opts = {}) {
    throw new Error(`${this.name}: send() not implemented`);
  }
  /** React to an existing message (if supported). No-op by default. */
  async react(to, message_id, emoji) {
    return { ok: false, reason: "react_not_supported" };
  }
  /** Download an attachment (if supported). */
  async download(file_id) {
    throw new Error(`${this.name}: download() not implemented`);
  }
}

module.exports = BaseChannel;
