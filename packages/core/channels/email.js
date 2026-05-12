"use strict";
const BaseChannel = require("./base");

/** Stub for SMTP-based email. Configure via SMTP_HOST/PORT/USER/PASS. */
class EmailChannel extends BaseChannel {
  constructor() {
    super("email");
    this.host = process.env.SMTP_HOST || null;
    this.port = parseInt(process.env.SMTP_PORT || "587", 10);
    this.user = process.env.SMTP_USER || null;
    this.pass = process.env.SMTP_PASS || null;
  }
  isEnabled() { return !!(this.host && this.user && this.pass); }
  async send() { throw new Error("email: not implemented (stub)"); }
}

module.exports = EmailChannel;
