"use strict";
const BaseChannel = require("./base");

/**
 * Stub. Real impl will go through the WhatsApp Cloud API once a phone-number-id
 * + permanent access token are provisioned. Until then, send() throws.
 */
class WhatsAppChannel extends BaseChannel {
  constructor() {
    super("whatsapp");
    this.phoneId = process.env.WHATSAPP_PHONE_ID || null;
    this.token = process.env.WHATSAPP_TOKEN || null;
  }
  isEnabled() { return !!(this.phoneId && this.token); }
  async send() { throw new Error("whatsapp: not implemented (stub)"); }
}

module.exports = WhatsAppChannel;
