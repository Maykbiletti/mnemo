"use strict";
const https = require("https");
const BaseChannel = require("./base");

class TelegramChannel extends BaseChannel {
  constructor() {
    super("telegram");
    this.token = process.env.TELEGRAM_BOT_TOKEN || null;
  }
  isEnabled() { return !!this.token; }

  _request(method, params) {
    return new Promise((resolve, reject) => {
      if (!this.token) return reject(new Error("TELEGRAM_BOT_TOKEN missing"));
      const body = JSON.stringify(params || {});
      const req = https.request({
        method: "POST",
        host: "api.telegram.org",
        path: `/bot${this.token}/${method}`,
        headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) },
      }, (resp) => {
        let buf = "";
        resp.on("data", c => buf += c);
        resp.on("end", () => {
          try { resolve(JSON.parse(buf)); }
          catch (e) { reject(e); }
        });
      });
      req.on("error", reject);
      req.write(body); req.end();
    });
  }

  async send(to, text, opts = {}) {
    const r = await this._request("sendMessage", {
      chat_id: to,
      text,
      reply_to_message_id: opts.reply_to,
      parse_mode: opts.parse_mode,
    });
    if (!r.ok) throw new Error("telegram send failed: " + (r.description || "unknown"));
    return { ok: true, message_id: r.result.message_id };
  }

  async react(to, message_id, emoji) {
    const r = await this._request("setMessageReaction", {
      chat_id: to,
      message_id,
      reaction: [{ type: "emoji", emoji }],
    });
    return { ok: !!r.ok, raw: r };
  }
}

module.exports = TelegramChannel;
