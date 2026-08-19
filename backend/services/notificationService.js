const EventEmitter = require('events');

class WhatsappNotifier extends EventEmitter {}

module.exports = new WhatsappNotifier();
