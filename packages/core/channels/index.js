"use strict";
const TelegramChannel = require("./telegram");
const WhatsAppChannel = require("./whatsapp");
const EmailChannel = require("./email");

const registry = new Map();

function register(channel) {
  registry.set(channel.name, channel);
}

register(new TelegramChannel());
register(new WhatsAppChannel());
register(new EmailChannel());

function get(name) {
  return registry.get(name) || null;
}
function all() {
  return Array.from(registry.values());
}
function enabled() {
  return all().filter(c => c.isEnabled()).map(c => c.name);
}

module.exports = { get, all, enabled, register };
